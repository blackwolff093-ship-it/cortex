import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { effectiveAgentFor, startDispatchLaunch, completeDispatchLaunch, requeueOrchTask, getConsecutiveFailures, getOrchTask, roleOf } from './db';
import { Notification } from 'electron';
import { logActivity } from './db';

const OPENCODE_MODEL = 'opencode/nemotron-3.5-lightning-free';

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

export function launchOpencode(taskId: number, roleKey: string, rootDir: string): Promise<{ ok: boolean, conversation_id?: string, error?: string }> {
  return new Promise((resolve) => {
    const launchId = startDispatchLaunch(taskId, roleKey);
    let settled = false;
    try {
      const task = getOrchTask(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Write .cortex/qa/<taskId>.json
      const qaDir = path.join(rootDir, '.cortex', 'qa');
      if (!fs.existsSync(qaDir)) {
        fs.mkdirSync(qaDir, { recursive: true });
      }
      
      let acceptanceCriteria = task.description;
      const match = task.description.match(/##\s*Acceptance criteria\s*([\s\S]*)/i);
      if (match && match[1].trim().length > 0) {
        acceptanceCriteria = match[1].trim();
      }

      const payload = {
        id: task.id,
        title: task.title,
        description: task.description,
        feedback: task.feedback,
        diff_payload: task.diff_payload,
        acceptance: acceptanceCriteria,
        verdict_file: `.cortex/qa/${taskId}.verdict.json`
      };
      
      const qaFile = path.join(qaDir, `${taskId}.json`);
      fs.writeFileSync(qaFile, JSON.stringify(payload, null, 2));

      const prompt = `1. Read the file .cortex/qa/${taskId}.json.
2. Run node tools/ui-probe.mjs '<route>' and read the JSON it prints.
3. Compare against the acceptance criteria.
4. Write .cortex/qa/${taskId}.verdict.json.tmp then rename it to .verdict.json, with exactly these four keys: {"task_id": ${taskId}, "agent": "opencode", "verdict": "APPROVED" | "REJECTED", "notes": "<text>"}.
5. Stop.`;

      const opencodeBin = fs.existsSync(path.join(process.env.HOME || '', '.opencode/bin/opencode')) 
        ? path.join(process.env.HOME || '', '.opencode/bin/opencode') 
        : 'opencode';

      const model = effectiveAgentFor(taskId, roleKey as any).model || OPENCODE_MODEL;

      const child = spawn(opencodeBin, [
        'run', prompt,
        '--format', 'json',
        '--model', model,
        '--title', `Task ${taskId} QA`,
        '--print-logs'
      ], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
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
        recordDispatchFailure(taskId, roleKey, 'opencode', err, launchId);
        requeueOrchTask(taskId, 'opencode', 'Spawn timeout');
        resolve({ ok: false, error: err });
      }, 5 * 60 * 1000);

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recordDispatchFailure(taskId, roleKey, 'opencode', err.message, launchId);
        requeueOrchTask(taskId, 'opencode', 'Spawn error');
        resolve({ ok: false, error: err.message });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        let conversationId: string | undefined = `opencode-${Date.now()}`;
        let hasError = false;
        let errorMessage = '';
        
        try {
          const lines = stdout.trim().split('\n').concat(stderr.trim().split('\n'));
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
               const parsed = JSON.parse(lines[i]);
               if (parsed.session_id || parsed.id || parsed.conversation_id) {
                 conversationId = parsed.session_id || parsed.id || parsed.conversation_id;
               }
               if (parsed.error) {
                 hasError = true;
                 errorMessage = parsed.error?.data?.message || parsed.error?.message || JSON.stringify(parsed.error);
                 break;
               }
            } catch (e) {}
          }
        } catch (e) {}

        if (hasError) {
          const errStr = `Exit Code: ${code}. Error: ${errorMessage}`;
          recordDispatchFailure(taskId, roleKey, 'opencode', errStr, launchId);
          requeueOrchTask(taskId, 'opencode', 'Opencode spawn failed');
          resolve({ ok: false, error: errStr });
          return;
        }
        
        completeDispatchLaunch(launchId, 'done', conversationId);
        
        logActivity({
          agent: 'system',
          action: 'dispatch-launch',
          path: null,
          detail: `Task ${taskId} dispatched to opencode with conversation ${conversationId}`
        });

        resolve({ ok: true, conversation_id: conversationId });
      });

    } catch (err: unknown) {
      if (settled) return;
      settled = true;
      const errorStr = err instanceof Error ? err.message : String(err);
      recordDispatchFailure(taskId, roleKey, 'opencode', errorStr, launchId);
      resolve({ ok: false, error: errorStr });
    }
  });
}
