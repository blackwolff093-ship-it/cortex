import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { effectiveAgentFor, startDispatchLaunch, completeDispatchLaunch, requeueOrchTask, getConsecutiveFailures, getOrchTask, roleOf, submitOrchWork, ROLE_CLAIMABLE, type RoleKey } from './db';
import { runTypeCheck } from './build-gate';
import { dispatchChildren } from './dispatch-timers';
import { Notification } from 'electron';
import { logActivity } from './db';

/* A reviewer only reads and judges; a coder edits and re-typechecks repeatedly, so it gets a bigger
 * budget and a longer leash. `claude -p` runs the whole session inside the child process, so this
 * timeout is total session wall-clock, not a launch handshake. (The old antigravity writer also got 45m.) */
const REVIEWER_BUDGET_USD = '1.00';
const CODER_BUDGET_USD = '5.00';
const REVIEWER_TIMEOUT_MS = 5 * 60 * 1000;
const CODER_TIMEOUT_MS = 45 * 60 * 1000;

/* What gets copied into the sandbox and diffed. The first three directories are in tsconfig's
 * include; the rest are root files that real tasks touch (build, packaging, seed). */
const SANDBOX_PATHS = [
  'electron', 'src', 'shared', 'seed',
  'vite.config.ts', 'package.json', 'tsconfig.json', 'electron-builder.yml', 'index.html',
];

/* Tools explicitly granted to the coder. The sandbox has no .claude/, so the project's broad
 * permission rules never load; this list is all it has. */
const CODER_ALLOWED_TOOLS = 'Edit,Write,Read,Glob,Grep,Bash(npx tsc:*),Bash(node_modules/.bin/tsc:*)';

const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_DIFF_CHARS = 380_000; // submitOrchWork rejects anything over 400000

function notifyUser(taskId: number, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const task = getOrchTask(taskId);
    new Notification({ title: task ? task.title : `Task #${taskId}`, body }).show();
  } catch (e) { /* notification is best-effort */ }
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
    notifyUser(taskId, `Repeated launch failures: ${truncatedError.substring(0, 50)}...`);
  }
}

/* The task may have already moved on (submitted, moved by the user, or waiting at a gate) before
 * the launcher reaches a failure path. Requeuing then would erase a successful hand-off and reopen
 * a gate the user closed — so only requeue while it is still ours. */
function requeueIfStillOurs(taskId: number, roleKey: string, reason: string): void {
  try {
    const task = getOrchTask(taskId);
    if (!task) return;
    const stillOurs =
      task.current_role === roleKey &&
      !task.gate_pending &&
      task.claimed_by === 'claude' &&
      (ROLE_CLAIMABLE[task.current_role as RoleKey] ?? []).includes(task.status);
    if (!stillOurs) {
      logActivity({
        agent: 'claude',
        action: 'dispatch-requeue-skipped',
        path: null,
        detail: `Task ${taskId}: already past this role (${task.current_role}/${task.status}) — not requeued`
      });
      return;
    }
    requeueOrchTask(taskId, 'claude', reason);
  } catch (e) { /* the failure path must never fail */ }
}

/* The sandbox: a working copy outside the repo with no .claude/, so the broad permission rules in
 * .claude/settings.local.json (including `Bash(node -e ...)`) never reach the agent at all,
 * and the real repo is untouched until the build gate passes. */
function prepareSandbox(rootDir: string, taskId: number): string {
  const dir = path.join(rootDir, '.cortex', 'work', String(taskId));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of SANDBOX_PATHS) {
    const src = path.join(rootDir, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  // Symlink, not a copy: node_modules is over half a gigabyte and we only need it so tsc runs.
  const nm = path.join(rootDir, 'node_modules');
  if (fs.existsSync(nm)) {
    try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir'); } catch (e) { /* already exists */ }
  }
  return dir;
}

function runDiff(a: string, b: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/diff', ['-ruN', a, b], { maxBuffer: DIFF_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => {
        // diff exits 0 when identical and 1 when there are differences — 1 is the success case here.
        const code = (err as NodeJS.ErrnoException & { code?: number } | null)?.code;
        if (err && typeof code === 'number' && code >= 2) return reject(err);
        if (err && typeof code !== 'number' && code !== undefined) return reject(err);
        resolve(stdout || '');
      });
  });
}

async function collectDiff(rootDir: string, sandbox: string): Promise<string> {
  const chunks: string[] = [];
  for (const rel of SANDBOX_PATHS) {
    const a = path.join(rootDir, rel);
    const b = path.join(sandbox, rel);
    if (!fs.existsSync(a) && !fs.existsSync(b)) continue;
    chunks.push(await runDiff(a, b));
  }
  const raw = chunks.join('');
  if (raw.length <= MAX_DIFF_CHARS) return raw;
  return raw.slice(0, MAX_DIFF_CHARS) +
    `\n\n[!] Diff truncated at ${MAX_DIFF_CHARS} characters — this is not the whole change.\n`;
}

/* Only after the build gate passes inside the sandbox do we copy the result into the real repo.
 * A failing gate means the repo was never touched at all. */
function applyBack(rootDir: string, sandbox: string): void {
  for (const rel of SANDBOX_PATHS) {
    const src = path.join(sandbox, rel);
    const dest = path.join(rootDir, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

function cleanupSandbox(sandbox: string): void {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* must never fail a submission */ }
}

export function launchClaude(taskId: number, roleKey: string, rootDir: string, stdioPath: string): Promise<{ ok: boolean, conversation_id?: string, error?: string }> {
  return new Promise((resolve) => {
    const isCoder = roleKey === 'coder';
    let launchId = 0;
    let sandbox = '';
    let settled = false;

    /* The only place `settled` is set, and right next to resolve, so no exception between the two
     * can swallow the settlement. */
    const finish = (r: { ok: boolean, conversation_id?: string, error?: string }) => {
      if (settled) return;
      settled = true;
      dispatchChildren.delete(taskId);
      resolve(r);
    };

    const failAndSettle = (err: string, reason: string) => {
      if (settled) return;
      try { recordDispatchFailure(taskId, roleKey, 'claude', err, launchId); } catch (e) { /* keep going */ }
      try { requeueIfStillOurs(taskId, roleKey, reason); } catch (e) { /* keep going */ }
      if (sandbox) cleanupSandbox(sandbox);
      finish({ ok: false, error: err });
    };

    try {
      launchId = startDispatchLaunch(taskId, roleKey);

      const userData = app.getPath('userData');
      const mcpConfigPath = path.join(userData, 'mcp-claude.json');
      const tmpPath = `${mcpConfigPath}.tmp`;

      const mcpConfig = {
        mcpServers: {
          cortex: {
            command: process.execPath,
            args: [stdioPath, "--agent", "claude"]
          }
        }
      };

      fs.writeFileSync(tmpPath, JSON.stringify(mcpConfig, null, 2));
      fs.renameSync(tmpPath, mcpConfigPath);

      if (isCoder) {
        try {
          sandbox = prepareSandbox(rootDir, taskId);
        } catch (err: unknown) {
          failAndSettle(
            `Failed to prepare the sandbox: ${err instanceof Error ? err.message : String(err)}`,
            'Sandbox preparation failed'
          );
          return;
        }
      }

      const coderPrompt = `You are the coder for task ${taskId}.
STRICT INSTRUCTIONS:
1. Task ${taskId} is already claimed for you. Read it with cortex_orchestrator_get_task and do not claim anything.
2. Honour its acceptance criteria and any reviewer feedback already on it.
3. Implement the change inside the current working directory. It is an isolated copy; the app collects your result itself.
4. Run npx tsc --noEmit -p tsconfig.json and keep working until it prints nothing at all.
5. Do NOT produce a diff and do NOT call cortex_orchestrator_submit_work — the app computes the diff and submits for you.
6. Never launch the CORTEX app or any Electron instance, and never write to cortex.db.
7. Stop calling tools.`;

      const reviewerPrompt = `You are the ${roleKey} reviewer for task ${taskId}.
STRICT INSTRUCTIONS:
1. Task ${taskId} is already claimed for you in the ${roleKey} role. Read it with cortex_orchestrator_get_task.
2. Do not modify, create or delete any file for any reason; your job is to judge.
3. Read the diff_payload, feedback, and acceptance criteria in the task description carefully.
4. Run npx tsc --noEmit -p tsconfig.json and verify it is completely silent.
5. Verify EVERY acceptance criterion by checking the actual code or making an actual measurement. You MUST mention the evidence (file:line) for each.
6. If ANY criterion fails or tsc is not silent, reject the task with numbered, specific, and actionable feedback. Do NOT approve anything without explicit evidence.
7. Call cortex_orchestrator_review_task with APPROVED or REJECTED and your feedback notes.
8. Stop.`;

      const prompt = isCoder ? coderPrompt : reviewerPrompt;

      const claudeBin = fs.existsSync('/opt/homebrew/bin/claude')
        ? '/opt/homebrew/bin/claude'
        : (fs.existsSync(path.join(process.env.HOME || '', '.local/bin/claude'))
            ? path.join(process.env.HOME || '', '.local/bin/claude')
            : 'claude');

      // The model comes from the role config (PIPELINE tab). Empty = the historical default.
      const model = effectiveAgentFor(taskId, roleKey as RoleKey).model || 'opus';

      const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
        '--model', model,
      ];
      if (isCoder) {
        // In -p mode there is no human to approve, so the coder needs acceptEdits to edit at all.
        args.push('--permission-mode', 'acceptEdits');
        args.push('--allowed-tools', CODER_ALLOWED_TOOLS);
        args.push('--max-budget-usd', CODER_BUDGET_USD);
      } else {
        args.push('--disallowed-tools', 'Edit,Write,Replace');
        args.push('--max-budget-usd', REVIEWER_BUDGET_USD);
      }

      const child = spawn(claudeBin, args, {
        cwd: isCoder ? sandbox : rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });
      dispatchChildren.set(taskId, child);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => stdout += data.toString());
      child.stderr.on('data', (data) => stderr += data.toString());

      const timeoutMs = isCoder ? CODER_TIMEOUT_MS : REVIEWER_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch(e){} }, 2000);
        } catch(e) {}
        failAndSettle(
          `Timeout (${Math.round(timeoutMs / 60000)}m). Stdout: ${stdout.substring(0, 500)}`,
          'Spawn timeout'
        );
      }, timeoutMs);

      child.on('error', (err: Error) => {
        if (settled) return;
        clearTimeout(timeout);
        failAndSettle(err.message, 'Spawn error');
      });

      /* The coder path after the process exits: the launcher itself computes the diff, runs the
       * build gate, applies back and submits. This mirrors POST /api/orchestrator/submit in
       * electron/server.ts; calling submitOrchWork directly is safe here precisely because the diff
       * is computed from disk rather than claimed by the agent, and the gate runs before submission. */
      const finalizeCoder = async () => {
        try {
          const diff = await collectDiff(rootDir, sandbox);
          if (!diff.trim()) {
            failAndSettle('The coder changed nothing: the diff against the repo is empty.', 'Coder produced no changes');
            return;
          }

          const gate = await runTypeCheck(sandbox);
          if (!gate.ok) {
            failAndSettle(`Build gate failed inside the sandbox:\n${gate.errors.substring(0, 2000)}`, 'Build gate failed');
            return;
          }

          applyBack(rootDir, sandbox);

          const summary = `claude (${model}) implemented task ${taskId} in an isolated sandbox; the build gate is clean.`;
          submitOrchWork(taskId, diff, summary, 'claude');

          cleanupSandbox(sandbox);
          completeDispatchLaunch(launchId, 'done', `claude-${taskId}`);
          logActivity({
            agent: 'claude',
            action: 'dispatch-submitted',
            path: null,
            detail: `Task ${taskId}: submitted a ${diff.length}-character diff after a clean build gate`
          });
          notifyUser(taskId, 'The coder finished and submitted its work for review.');
          finish({ ok: true, conversation_id: `claude-${taskId}` });
        } catch (err: unknown) {
          failAndSettle(
            `Failed to collect or submit the work: ${err instanceof Error ? err.message : String(err)}`,
            'Finalize failed'
          );
        }
      };

      child.on('close', (code) => {
        if (settled) return;
        clearTimeout(timeout);
        dispatchChildren.delete(taskId);

        if (isCoder) {
          if (code !== 0) {
            failAndSettle(stderr || stdout || `claude exited with code ${code}`, 'Claude coder failed');
            return;
          }
          void finalizeCoder();
          return;
        }

        let conversationId: string | undefined;
        let hasError = false;

        try {
          // Find the last valid JSON object in stdout (claude might print warnings before json)
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
               const parsed = JSON.parse(lines[i]);
               if (parsed.session_id || parsed.id || parsed.conversation_id) {
                 conversationId = parsed.session_id || parsed.id || parsed.conversation_id;
                 if (parsed.error) hasError = true;
                 break;
               }
            } catch (e) {}
          }
        } catch (e) {}

        if (!conversationId) {
           const convMatch = stdout.match(/"session_id"\s*:\s*"([^"]+)"/);
           if (convMatch) conversationId = convMatch[1];
        }

        if (code !== 0 || hasError || !conversationId) {
          failAndSettle(stderr || stdout || 'Failed to spawn claude', 'Claude spawn failed');
          return;
        }

        completeDispatchLaunch(launchId, 'done', conversationId);

        logActivity({
          agent: 'system',
          action: 'dispatch-launch',
          path: null,
          detail: `Task ${taskId} dispatched to claude with conversation ${conversationId}`
        });

        finish({ ok: true, conversation_id: conversationId });
      });

    } catch (err: unknown) {
      failAndSettle(err instanceof Error ? err.message : String(err), 'Launcher error');
    }
  });
}
