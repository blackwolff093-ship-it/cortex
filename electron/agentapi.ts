
import { Notification } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { effectiveAgentFor, logActivity, isTaskDispatchActive, startDispatchLaunch, completeDispatchLaunch, getOrchTask, ROLE_CLAIMABLE, roleOf, claimOrchTaskById, requeueOrchTask, heartbeatOrchTask, getConsecutiveFailures, conn, getActiveDispatchLaunchesCount, getActiveDispatchTask, MAX_CONCURRENT_DISPATCH } from './db';
import { writeDispatchFile } from './dispatcher';
import { dispatchTimers, dispatchAbandonTimers } from './dispatch-timers';

const execFileAsync = promisify(execFile);

export interface AntigravityEnv {
  address: string;
  csrfToken: string;
  projectId: string;
}

const LS_BIN = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
let cachedEnv: AntigravityEnv | null = null;

export async function discoverAntigravity(rootDir: string): Promise<AntigravityEnv | null> {
  if (cachedEnv) return cachedEnv;

  try {
    const psOutput = (await execFileAsync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' })).stdout;
    const lines = psOutput.split('\n');
    let pid = '';
    let csrfToken = '';
    
    for (const line of lines) {
      if (line.includes('language_server') && line.includes('--standalone')) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (match) {
          pid = match[1];
          const args = match[2].split(/\s+/);
          const idx = args.indexOf('--csrf_token');
          if (idx !== -1 && idx + 1 < args.length) {
            csrfToken = args[idx + 1].startsWith('=') ? args[idx+1].slice(1) : args[idx + 1];
            break;
          }
          const tokenMatch = match[2].match(/--csrf_token=([^\s]+)/);
          if (tokenMatch) {
            csrfToken = tokenMatch[1];
            break;
          }
        }
      }
    }

    if (!pid || !csrfToken) return null;

    const lsofOutput = (await execFileAsync('lsof', ['-nP', '-p', pid], { encoding: 'utf8' })).stdout;
    const lsofLines = lsofOutput.split('\n');
    let validPort = '';

    for (const line of lsofLines) {
      if (line.includes('LISTEN') && line.includes('127.0.0.1:')) {
        const portMatch = line.match(/127\.0\.0\.1:(\d+)/);
        if (portMatch) {
          const port = portMatch[1];
          const address = `127.0.0.1:${port}`;
          
          try {
            await execFileAsync(LS_BIN, ['agentapi', 'get-conversation-metadata', '__probe__'], {
              env: {
                ...process.env,
                ANTIGRAVITY_LS_ADDRESS: address,
                ANTIGRAVITY_CSRF_TOKEN: csrfToken
              },
              encoding: 'utf8'
            });
          } catch (err: unknown) {
            const error = err as { stdout?: string, stderr?: string, message?: string };
            const combined = String(error.stdout || '') + String(error.stderr || '');
            if (combined.includes('trajectory not found')) {
              validPort = port;
              break;
            }
          }
        }
      }
    }

    if (!validPort) return null;
    const address = `127.0.0.1:${validPort}`;

    const homeDir = os.homedir();
    // Antigravity settings path, do not delete
    const projectsDir = path.join(homeDir, '.gemini', 'config', 'projects');
    let projectId = '';
    
    if (fs.existsSync(projectsDir)) {
      const files = fs.readdirSync(projectsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(projectsDir, file), 'utf8'));
            if (data.projectResources && Array.isArray(data.projectResources.resources)) {
              for (const res of data.projectResources.resources) {
                if (res.folderUri === `file://${rootDir}`) {
                  projectId = data.id;
                  break;
                }
              }
            }
          } catch (e) {
          }
          if (projectId) break;
        }
      }
    }

    if (!projectId) return null;

    cachedEnv = { address, csrfToken, projectId };
    return cachedEnv;
  } catch (err) {
    return null;
  }
}

export function resetAntigravityCache(): void {
  cachedEnv = null;
}


function recordDispatchFailure(taskId: number, roleKey: string, agent: string, error: string, launchId: number) {
  const truncatedError = error.substring(0, 1000);
  logActivity({
    agent,
    action: 'dispatch-failed',
    path: null,
    detail: `Task ${taskId} (${roleKey}): ${truncatedError}`
  });
  
  if (launchId) {
    completeDispatchLaunch(launchId, 'failed', undefined, error);
  }
  
  const fails = getConsecutiveFailures(taskId);
  if (fails === 2) {
    try {
      if (Notification.isSupported()) {
        const task = getOrchTask(taskId);
        new Notification({
          title: task ? task.title : `Task #${taskId}`,
          body: `Repeated launch failures: ${truncatedError.substring(0, 50)}...`
        }).show();
      }
    } catch(e) {}
  }
}

export async function dispatchTask(taskId: number, roleKey: string, rootDir: string, stdioPath: string): Promise<{ok: boolean, conversation_id?: string, error?: string}> {
  const task = getOrchTask(taskId);
  if (!task) return { ok: false, error: 'Task not found' };

  if (getActiveDispatchLaunchesCount() >= MAX_CONCURRENT_DISPATCH) {
    const activeTask = getActiveDispatchTask();
    const err = activeTask ? `Concurrent dispatch limit (${MAX_CONCURRENT_DISPATCH}) reached. Currently busy with task ${activeTask.task_id} - ${activeTask.title}` : `Concurrent dispatch limit (${MAX_CONCURRENT_DISPATCH}) reached.`;
    // Only return the error, do NOT record it as a failure for THIS task, to avoid polluting the audit log of an unrelated task just because it was queued.
    return { ok: false, error: err };
  }

  if (!ROLE_CLAIMABLE[task.current_role]?.includes(task.status)) {
    const err = `Task status is ${task.status}`;
    recordDispatchFailure(taskId, roleKey, 'system', err, startDispatchLaunch(taskId, roleKey));
    return { ok: false, error: err };
  }

  const roleConfig = roleOf(task.current_role);
  // The per-task choice (picker modal) overrides the global pipeline config.
  const picked = effectiveAgentFor(taskId, task.current_role);
  const agentName = picked.agent;
  if (agentName !== 'antigravity' && agentName !== 'claude' && agentName !== 'opencode') {
    const err = `No launcher registered for agent ${agentName}`;
    recordDispatchFailure(taskId, roleKey, agentName, err, startDispatchLaunch(taskId, roleKey));
    return { ok: false, error: err };
  }

  if (isTaskDispatchActive(taskId)) {
    const err = 'Task already active in the last 15 minutes.';
    recordDispatchFailure(taskId, roleKey, 'system', err, startDispatchLaunch(taskId, roleKey));
    return { ok: false, error: err };
  }

  const claimRes = claimOrchTaskById(agentName, taskId);
  if (claimRes.reason !== 'ok') {
    const err = `Failed to claim task: ${claimRes.reason}`;
    recordDispatchFailure(taskId, roleKey, agentName, err, startDispatchLaunch(taskId, roleKey));
    return { ok: false, error: err };
  }

  if (agentName === 'claude') {
    const { launchClaude } = await import('./claude-launcher.js');
    return await launchClaude(taskId, task.current_role, rootDir, stdioPath);
  }

  if (agentName === 'opencode') {
    const { launchOpencode } = await import('./opencode-launcher.js');
    return await launchOpencode(taskId, task.current_role, rootDir);
  }

  let env = await discoverAntigravity(rootDir);
  if (!env) {
    resetAntigravityCache();
    env = await discoverAntigravity(rootDir);
    if (!env) {
      requeueOrchTask(taskId, agentName, 'Antigravity discovery failed');
      const err = 'Antigravity discovery failed. Make sure the app is running.';
      recordDispatchFailure(taskId, roleKey, agentName, err, startDispatchLaunch(taskId, roleKey));
      return { ok: false, error: err };
    }
  }

  const timestamp = Date.now();
  const baselineDir = path.join(rootDir, 'backups', `dispatch-${taskId}-${timestamp}`);
  
  try {
    fs.mkdirSync(baselineDir, { recursive: true });
    
    if (fs.existsSync(path.join(rootDir, 'electron'))) {
      await execFileAsync('cp', ['-R', path.join(rootDir, 'electron'), path.join(baselineDir, 'electron')]);
    }
    if (fs.existsSync(path.join(rootDir, 'src'))) {
      await execFileAsync('cp', ['-R', path.join(rootDir, 'src'), path.join(baselineDir, 'src')]);
    }
  } catch (err: unknown) {
    const error = err as Error;
    requeueOrchTask(taskId, agentName, 'Failed to create baseline snapshot');
    const errStr = `Failed to create baseline snapshot: ${error.message}`;
    recordDispatchFailure(taskId, roleKey, agentName, errStr, startDispatchLaunch(taskId, roleKey));
    return { ok: false, error: errStr };
  }

  writeDispatchFile(task, baselineDir);

  const prompt = `Please complete task ${taskId}.
STRICT CONSTRAINTS (violating any of these fails the task):
1. No network access
2. Do not start any application
3. Do not run sqlite3
4. Do not use MCP tools
5. Only use files for communication. Follow instructions in .cortex/dispatch/${taskId}.json
6. NEVER set BypassSandbox (it will hang forever)
7. NEVER read or list anything outside the workspace

If the dispatch file lists skills, read every path in it before you start and follow them. They are proven working methods, not suggestions.

PROTOCOL:
1. Read the dispatch file: .cortex/dispatch/${taskId}.json
2. Implement the requested changes
3. Run tsc (npx tsc --noEmit -p tsconfig.json) until it prints nothing
4. Build the diff and save to .cortex/outbox/${taskId}.diff (comparing against baseline_dir)
5. Write the outbox payload to .cortex/outbox/${taskId}.json.tmp then rename to .json. The payload MUST be EXACTLY these four keys: {"task_id": ${taskId}, "agent": "${agentName}", "summary": "<one line>", "diff": "<full text of .cortex/outbox/${taskId}.diff>"}
6. Write a report to .cortex/outbox/${taskId}-report.md
7. STOP calling tools.`;

  const attemptCount = (conn().prepare('SELECT COUNT(*) as c FROM dispatch_launches WHERE task_id = ?').get(taskId) as {c: number}).c + 1;
  const timeStr = new Date().toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit', hour12: false});
  const convTitle = `Task ${taskId} · r${attemptCount} · ${timeStr}`;

  const launchId = startDispatchLaunch(taskId, roleKey);
  return new Promise((resolve) => {
    let settled = false;
    try {
      const child = spawn(LS_BIN, [
        'agentapi', 'new-conversation',
        `--model=${picked.model || 'pro'}`,
        `--title=${convTitle}`,
        prompt
      ], {
        env: {
          ...process.env,
          ANTIGRAVITY_LS_ADDRESS: env!.address,
          ANTIGRAVITY_CSRF_TOKEN: env!.csrfToken,
          ANTIGRAVITY_PROJECT_ID: env!.projectId
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => stdout += data.toString());
      child.stderr.on('data', (data) => stderr += data.toString());

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch(e){} }, 2000);
        } catch(e) {}
        const err = `Timeout (5m): Process did not exit and output was empty/stalled. Stdout: ${stdout.substring(0, 500)}`;
        recordDispatchFailure(taskId, roleKey, agentName, err, launchId);
        resetAntigravityCache();
        requeueOrchTask(taskId, agentName, 'Spawn timeout');
        resolve({ ok: false, error: err });
      }, 5 * 60 * 1000);

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recordDispatchFailure(taskId, roleKey, agentName, err.message, launchId);
        resetAntigravityCache();
        requeueOrchTask(taskId, agentName, 'Spawn error');
        resolve({ ok: false, error: err.message });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        
        let hasError = false;
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.error) hasError = true;
        } catch (e) {}
        
        const convIdMatch = stdout.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        const conversationId = convIdMatch ? convIdMatch[0] : undefined;

        if (code !== 0 || hasError || !conversationId) {
          const err = stderr || stdout || 'Failed to spawn conversation';
          recordDispatchFailure(taskId, roleKey, agentName, err, launchId);
          resetAntigravityCache(); // Reset cache on failure
          requeueOrchTask(taskId, agentName, 'Spawn failed');
          resolve({ ok: false, error: err });
          return;
        }
        
        completeDispatchLaunch(launchId, 'active', conversationId);
        
        if (dispatchTimers.has(taskId)) {
          clearInterval(dispatchTimers.get(taskId)!);
        }
        const timer = setInterval(() => {
          heartbeatOrchTask(taskId, agentName);
        }, 5 * 60 * 1000);
        dispatchTimers.set(taskId, timer);

        if (dispatchAbandonTimers.has(taskId)) {
          clearTimeout(dispatchAbandonTimers.get(taskId)!);
        }
        const abandonTimer = setTimeout(() => {
          completeDispatchLaunch(launchId, 'abandoned');
          requeueOrchTask(taskId, agentName, 'Launch abandoned after 45 minutes without result');
          logActivity({
            agent: 'system',
            action: 'dispatch-abandoned',
            path: null,
            detail: `Task ${taskId} launch abandoned after 45 minutes`
          });
          if (dispatchTimers.has(taskId)) {
            clearInterval(dispatchTimers.get(taskId)!);
            dispatchTimers.delete(taskId);
          }
          dispatchAbandonTimers.delete(taskId);
        }, 45 * 60 * 1000);
        dispatchAbandonTimers.set(taskId, abandonTimer);

        logActivity({
          agent: 'system',
          action: 'dispatch-launch',
          path: null,
          detail: `Task ${taskId} dispatched with conversation ${conversationId}`
        });

        resolve({ ok: true, conversation_id: conversationId });
      });
    } catch (err: unknown) {
      if (settled) return;
      settled = true;
      const errorStr = err instanceof Error ? err.message : String(err);
      recordDispatchFailure(taskId, roleKey, agentName, errorStr, launchId);
      resolve({ ok: false, error: errorStr });
    }
  });
}
