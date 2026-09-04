import { Notification } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { claimOrchTaskById, submitOrchWork, logActivity, getOrchTask, OrchTask, closeTaskDispatchLaunches, cleanupAbandonedDispatchLaunches, requeueOrchTask, emitChange, conn, reviewOrchTask } from './db';
import { dispatchTimers, dispatchAbandonTimers, dispatchChildren } from './dispatch-timers';

let watcher: fs.FSWatcher | null = null;
let qaWatcher: fs.FSWatcher | null = null;
const processingFiles = new Set<string>();
let dispatchDir = '';
let outboxDir = '';
let processedDir = '';
let qaDir = '';
let qaProcessedDir = '';
let baselineDir = '';
let stdioPath = '';
let globalRootDir = '';
import { initAutoWakeup } from './auto-wakeup';
import { runTypeCheck, verifyDiffApplied } from './build-gate';
const debounceTimers = new Map<string, NodeJS.Timeout>();
const gateRejections = new Map<number, { gate: string, count: number }>();

export function initDispatcher(rootDir: string, baselineDirOption: string = rootDir, stdioPathOption: string = ''): void {
  stdioPath = stdioPathOption;
  globalRootDir = rootDir;
  baselineDir = baselineDirOption;
  dispatchDir = path.join(rootDir, '.cortex', 'dispatch');
  outboxDir = path.join(rootDir, '.cortex', 'outbox');
  processedDir = path.join(outboxDir, 'processed');
  qaDir = path.join(rootDir, '.cortex', 'qa');
  qaProcessedDir = path.join(qaDir, 'processed');

  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(qaDir, { recursive: true });
  fs.mkdirSync(qaProcessedDir, { recursive: true });

  const abandoned = cleanupAbandonedDispatchLaunches(45 * 60 * 1000);
  for (const a of abandoned) {
    if (a.held) {
      requeueOrchTask(a.taskId, a.agent!, 'System restarted while task was dispatched');
      logActivity({
        agent: 'system',
        action: 'dispatch-abandoned',
        path: null,
        detail: `Task ${a.taskId} freed on startup: dispatch was left active`
      });
    } else {
      logActivity({
        agent: 'system',
        action: 'dispatch-abandoned',
        path: null,
        detail: `Task ${a.taskId} dispatch closed on startup: task had already progressed`
      });
    }
  }

  const existingFiles = fs.readdirSync(outboxDir);
  for (const file of existingFiles) {
    if (file.endsWith('.json') && fs.statSync(path.join(outboxDir, file)).isFile()) {
      processOutboxFile(file);
    }
  }

  const existingQaFiles = fs.readdirSync(qaDir);
  for (const file of existingQaFiles) {
    if (file.endsWith('.verdict.json') && fs.statSync(path.join(qaDir, file)).isFile()) {
      processQaFile(file);
    }
  }

  startOutboxWatcher();
  startQaWatcher();
  initAutoWakeup(rootDir, stdioPathOption);
}

export function writeDispatchFile(task: OrchTask, overrideBaselineDir?: string): string {
  let taskSkills: string[] = [];
  try { taskSkills = JSON.parse(task.skills || '[]'); } catch (e) {}

  if (!Array.isArray(taskSkills) || taskSkills.length === 0) {
    const pConfig = conn().prepare("SELECT default_skills FROM orchestrator_pipeline_config WHERE role_key = ?").get(task.current_role) as { default_skills: string } | undefined;
    if (pConfig && pConfig.default_skills) {
      try { taskSkills = JSON.parse(pConfig.default_skills); } catch (e) {}
    }
  }
  if (!Array.isArray(taskSkills)) taskSkills = [];

  const dispatchedSkills: any[] = [];
  const cortexSkillsDir = path.join(globalRootDir, '.cortex', 'skills');
  
  if (taskSkills.length > 0) {
    if (!fs.existsSync(cortexSkillsDir)) {
      fs.mkdirSync(cortexSkillsDir, { recursive: true });
    }

    for (const skillName of taskSkills) {
      const skillRow = conn().prepare("SELECT source_id, rel_dir, description, enabled FROM skills WHERE name = ?").get(skillName) as any;
      if (!skillRow) continue;
      if (skillRow.enabled === 0) {
        logActivity({ agent: 'system', action: 'dispatch-skill-disabled', path: null, detail: `Skill ${skillName} is disabled, ignoring.` });
        continue;
      }
      const { skillsDir } = require('./skills');
      const srcDir = path.join(skillsDir(), skillRow.source_id, skillRow.rel_dir);
      const destDir = path.join(cortexSkillsDir, skillName);
      if (fs.existsSync(srcDir)) {
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.cpSync(srcDir, destDir, { recursive: true });
      }
      dispatchedSkills.push({
        name: skillName,
        description: skillRow.description,
        path: `.cortex/skills/${skillName}/SKILL.md`
      });
    }
  }

  if (fs.existsSync(cortexSkillsDir)) {
    const existingDirs = fs.readdirSync(cortexSkillsDir);
    for (const dir of existingDirs) {
      if (!taskSkills.includes(dir)) {
        fs.rmSync(path.join(cortexSkillsDir, dir), { recursive: true, force: true });
      }
    }
  }

  const payload = {
    id: task.id,
    role_key: task.current_role,
    title: task.title,
    description: task.description,
    feedback: task.feedback || '',
    context_files: task.context_files || [],
    baseline_dir: overrideBaselineDir || baselineDir,
    result_file: `.cortex/outbox/${task.id}.json`,
    skills: dispatchedSkills
  };

  const filePath = path.join(dispatchDir, `${task.id}.json`);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export function startOutboxWatcher(): void {
  if (watcher) return;
  
  watcher = fs.watch(outboxDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    
    // Debounce
    if (debounceTimers.has(filename)) {
      clearTimeout(debounceTimers.get(filename)!);
    }
    
    const timer = setTimeout(() => {
      debounceTimers.delete(filename);
      processOutboxFile(filename);
    }, 150);
    debounceTimers.set(filename, timer);
  });
}

interface OutboxPayload {
  task_id: number;
  agent: string;
  summary: string;
  diff: string;
}

function isOutboxPayload(data: unknown): data is OutboxPayload {
  if (!data || typeof data !== 'object') return false;
  const p = data as Record<string, unknown>;
  return (
    typeof p.task_id === 'number' && Number.isFinite(p.task_id) &&
    typeof p.agent === 'string' && p.agent.trim().length > 0 &&
    typeof p.summary === 'string' && p.summary.trim().length > 0 &&
    typeof p.diff === 'string' && p.diff.trim().length > 0
  );
}

function processOutboxFile(filename: string): void {
  if (processingFiles.has(filename)) return;
  processingFiles.add(filename);
  
  const filePath = path.join(outboxDir, filename);
  
  // Try up to 5 times with 200ms delay for JSON parse / ENOENT
  let attempts = 0;
  const tryProcess = async () => {
    let data: unknown;
    try {
      if (!fs.existsSync(filePath)) {
        processingFiles.delete(filename);
        return;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) {
        attempts++;
        if (attempts < 5) {
          setTimeout(tryProcess, 200);
          return;
        }
        // Failed parsing 5 times
        try {
          const invalidPath = path.join(processedDir, `${filename}.invalid`);
          fs.renameSync(filePath, invalidPath);
          logActivity({
            agent: 'system',
            action: 'dispatch-invalid',
            path: null,
            detail: `Failed parsing outbox file ${filename}: ${err instanceof Error ? err.message : String(err)}`
          });
        } catch (_) {}
        processingFiles.delete(filename);
        return;
      }
      
      // If it's another error, log and move to .error
      try {
        const errorPath = path.join(processedDir, `${filename}.error`);
        fs.renameSync(filePath, errorPath);
        logActivity({
          agent: 'system',
          action: 'dispatch-error',
          path: null,
          detail: `Failed to read outbox file ${filename}: ${err instanceof Error ? err.message : String(err)}`
        });
      } catch (_) {}
      processingFiles.delete(filename);
      return;
    }

    // Now process the parsed data (no retries)
    try {
      if (!isOutboxPayload(data)) {
        throw new Error('Invalid payload schema');
      }

      const { task_id, agent, summary, diff } = data;

      if (dispatchTimers.has(task_id)) {
        clearInterval(dispatchTimers.get(task_id));
        dispatchTimers.delete(task_id);
      }
      if (dispatchAbandonTimers.has(task_id)) {
        clearTimeout(dispatchAbandonTimers.get(task_id));
        dispatchAbandonTimers.delete(task_id);
      }

      const currentTask = getOrchTask(task_id);
      if (!currentTask) {
        const orphanedPath = path.join(processedDir, `${filename}.orphaned`);
        fs.renameSync(filePath, orphanedPath);
        logActivity({
          agent: agent || 'system',
          action: 'dispatch-orphaned',
          path: null,
          detail: `Orphaned outbox file ${filename}: task #${task_id} was deleted`
        });
        processingFiles.delete(filename);
        return;
      }

      const latestLaunch = conn()
        .prepare("SELECT status FROM dispatch_launches WHERE task_id = ? ORDER BY launched_at DESC LIMIT 1")
        .get(task_id) as { status: string } | undefined;
        
      if (latestLaunch?.status === 'cancelled') {
        const invalidPath = path.join(processedDir, `${filename}.cancelled`);
        fs.renameSync(filePath, invalidPath);
        logActivity({
          agent: agent,
          action: 'dispatch-ignored',
          path: null,
          detail: `Ignored outbox file ${filename}: task was stopped/cancelled by user`
        });
        processingFiles.delete(filename);
        return;
      }

      if (currentTask.claimed_by !== agent) {
        const claimResult = claimOrchTaskById(agent, task_id);
        
        if (claimResult.task?.id !== task_id || claimResult.reason !== 'ok') {
          const invalidPath = path.join(processedDir, `${filename}.rejected`);
          fs.renameSync(filePath, invalidPath);
          logActivity({
            agent: agent,
            action: 'dispatch-reject',
            path: null,
            detail: `Rejected outbox file ${filename}: claim result ${claimResult.reason}`
          });
          closeTaskDispatchLaunches(task_id, 'failed');
          processingFiles.delete(filename);
          return;
        }
      }

      if (agent !== 'user') {
        const diffPayload = typeof diff === 'string' ? diff : '';
        const diffCheck = verifyDiffApplied(globalRootDir, diffPayload, task_id);
        if (!diffCheck.ok) {
          const failedPath = path.join(processedDir, `${filename}.diff-failed`);
          fs.renameSync(filePath, failedPath);
          
          let gateData = gateRejections.get(task_id) || { gate: 'diff', count: 0 };
          if (gateData.gate !== 'diff') gateData = { gate: 'diff', count: 0 };
          gateData.count += 1;
          gateRejections.set(task_id, gateData);

          const taskRow = getOrchTask(task_id);
          if (taskRow) {
            let newFeedback = (taskRow.feedback ? taskRow.feedback + '\n\n' : '') + `${diffCheck.error}`;
            if (gateData.count >= 3) {
              newFeedback += `\n\n[Auto-Gate] Task rejected 3 consecutive times by diff gate. Needs human intervention.`;
              conn().prepare("UPDATE orchestrator_tasks SET status = 'FAILED', feedback = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?").run(newFeedback, Date.now(), task_id);
              logActivity({ agent, action: 'orch-failed', path: null, detail: `#${task_id} failed after 3 consecutive diff gate rejections` });
              closeTaskDispatchLaunches(task_id, 'failed', diffCheck.error);
              emitChange('orchestrator');
              processingFiles.delete(filename);
              return;
            } else {
              conn().prepare('UPDATE orchestrator_tasks SET feedback = ?, updated_at = ? WHERE id = ?')
                .run(newFeedback, Date.now(), task_id);
            }
          }
          
          logActivity({
            agent: agent,
            action: 'submit-diff-failed',
            path: null,
            detail: diffCheck.error || 'Diff failed'
          });
          
          closeTaskDispatchLaunches(task_id, 'failed', diffCheck.error);
          requeueOrchTask(task_id, agent, 'Diff check failed');
          emitChange('orchestrator');
          
          processingFiles.delete(filename);
          return;
        }
      }

      // --- Build Gate ---
      const typecheck = await runTypeCheck(globalRootDir);
      if (!typecheck.ok) {
        const failedPath = path.join(processedDir, `${filename}.typecheck-failed`);
        fs.renameSync(filePath, failedPath);
        
        let gateData = gateRejections.get(task_id) || { gate: 'typecheck', count: 0 };
        if (gateData.gate !== 'typecheck') gateData = { gate: 'typecheck', count: 0 };
        gateData.count += 1;
        gateRejections.set(task_id, gateData);

        const taskRow = getOrchTask(task_id);
        if (taskRow) {
          let newFeedback = (taskRow.feedback ? taskRow.feedback + '\n\n' : '') + `[Auto-Gate] Typecheck failed:\n${typecheck.errors}`;
          if (gateData.count >= 3) {
            newFeedback += `\n\n[Auto-Gate] Task rejected 3 consecutive times by typecheck gate. Needs human intervention.`;
            conn().prepare("UPDATE orchestrator_tasks SET status = 'FAILED', feedback = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?").run(newFeedback, Date.now(), task_id);
            logActivity({ agent, action: 'orch-failed', path: null, detail: `#${task_id} failed after 3 consecutive typecheck gate rejections` });
            closeTaskDispatchLaunches(task_id, 'failed', typecheck.errors);
            emitChange('orchestrator');
            try {
              if (Notification.isSupported()) {
                new Notification({ title: taskRow.title, body: `Task #${task_id} — typecheck failed` }).show();
              }
            } catch (err) {}
            processingFiles.delete(filename);
            return;
          } else {
            conn().prepare('UPDATE orchestrator_tasks SET feedback = ?, updated_at = ? WHERE id = ?')
              .run(newFeedback, Date.now(), task_id);
          }
        }
        
        const firstErrorLine = typecheck.errors.split('\n').find(l => l.trim().length > 0) || 'Unknown error';
        logActivity({
          agent: agent,
          action: 'submit-typecheck-failed',
          path: null,
          detail: firstErrorLine
        });
        
        closeTaskDispatchLaunches(task_id, 'failed', typecheck.errors);
        
        try {
          const failedTask = getOrchTask(task_id);
          if (failedTask && Notification.isSupported()) {
            new Notification({
              title: failedTask.title,
              body: `Task #${task_id} — typecheck failed`
            }).show();
          }
        } catch (err) {}
        
        requeueOrchTask(task_id, agent, 'Typecheck failed');
        emitChange('orchestrator');
        
        processingFiles.delete(filename);
        return;
      }
      // ------------------
      
      gateRejections.delete(task_id);
      
      submitOrchWork(task_id, diff, summary, agent);
      closeTaskDispatchLaunches(task_id, 'done');
      
      try {
        
        const updatedTask = getOrchTask(task_id);
        if (updatedTask && Notification.isSupported()) {
          new Notification({
            title: updatedTask.title,
            body: `Task #${task_id} — now at: ${updatedTask.current_role}`
          }).show();
        }
      } catch (err) {}
      
      try {
        const processedPath = path.join(processedDir, filename);
        fs.renameSync(filePath, processedPath);
      } catch (err: unknown) {
        logActivity({
          agent,
          action: 'dispatch-error',
          path: null,
          detail: `Work submitted but failed to rename outbox file ${filename}: ${err instanceof Error ? err.message : String(err)}`
        });
      }

      processingFiles.delete(filename);
    } catch (err: unknown) {
      // Any logic error or db throw
      try {
        const invalidPath = path.join(processedDir, `${filename}.rejected`);
        fs.renameSync(filePath, invalidPath);
        
        let agentStr = 'system';
        if (data && typeof data === 'object') {
          const parsedData = data as Record<string, unknown>;
          if (typeof parsedData.agent === 'string') {
            agentStr = parsedData.agent;
          }
          if (typeof parsedData.task_id === 'number') {
            closeTaskDispatchLaunches(parsedData.task_id, 'failed');
          }
        }

        logActivity({
          agent: agentStr,
          action: 'dispatch-reject',
          path: null,
          detail: `Rejected outbox file ${filename}: ${err instanceof Error ? err.message : String(err)}`
        });
      } catch (_) {}
      processingFiles.delete(filename);
    }
  };
  
  tryProcess();
}

export function stopDispatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (qaWatcher) {
    qaWatcher.close();
    qaWatcher = null;
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}


// Auto wakeup logic has been moved to auto-wakeup.ts to break circular imports.

export function stopOrchTask(taskId: number, agent: string) {
  
  const launch = conn()
    .prepare("SELECT * FROM dispatch_launches WHERE task_id = ? AND status IN ('active', 'launching') ORDER BY launched_at DESC LIMIT 1")
    .get(taskId) as { id: number, conversation_id: string | null } | undefined;
  
  if (launch) {
    conn().prepare("UPDATE dispatch_launches SET status = 'cancelled' WHERE id = ?").run(launch.id);
  }
  conn().prepare("UPDATE orchestrator_tasks SET auto_blocked = 1 WHERE id = ?").run(taskId);
  
  
  const timer = dispatchTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    dispatchTimers.delete(taskId);
  }
  const abandonTimer = dispatchAbandonTimers.get(taskId);
  if (abandonTimer) {
    clearTimeout(abandonTimer);
    dispatchAbandonTimers.delete(taskId);
  }

  // A launcher that spawns the agent in-process registers its child here, so
  // STOP actually kills the run instead of only marking the row cancelled.
  const child = dispatchChildren.get(taskId);
  if (child) {
    try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    dispatchChildren.delete(taskId);
  }

  requeueOrchTask(taskId, agent);
  
  logActivity({
    agent,
    action: 'dispatch-cancelled',
    path: null,
    detail: `Stopped dispatch for task #${taskId}. External agent session might continue in the background.`
  });
  
  emitChange('orchestrator');
}

export function startQaWatcher(): void {
  if (qaWatcher) return;
  
  qaWatcher = fs.watch(qaDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.verdict.json')) return;
    
    if (debounceTimers.has(filename)) {
      clearTimeout(debounceTimers.get(filename)!);
    }
    
    const timer = setTimeout(() => {
      debounceTimers.delete(filename);
      processQaFile(filename);
    }, 150);
    debounceTimers.set(filename, timer);
  });
}

export function processQaFile(filename: string): void {
  if (processingFiles.has(filename)) return;
  processingFiles.add(filename);

  const filePath = path.join(qaDir, filename);
  let retries = 0;

  const tryProcess = () => {
    let data: any = null;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.trim()) throw new Error('Empty file');
      data = JSON.parse(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        processingFiles.delete(filename);
        return;
      }
      
      if (err instanceof SyntaxError || (err as Error).message === 'Empty file') {
        if (retries < 5) {
          retries++;
          setTimeout(tryProcess, 200);
          return;
        }
        try {
          const invalidPath = path.join(qaProcessedDir, `${filename}.invalid`);
          fs.renameSync(filePath, invalidPath);
        } catch (_) {}
        processingFiles.delete(filename);
        return;
      }
      
      try {
        const errorPath = path.join(qaProcessedDir, `${filename}.error`);
        fs.renameSync(filePath, errorPath);
      } catch (_) {}
      processingFiles.delete(filename);
      return;
    }

    try {
      if (!data || typeof data !== 'object' || typeof data.task_id !== 'number' || typeof data.agent !== 'string' || typeof data.verdict !== 'string' || typeof data.notes !== 'string') {
        throw new Error('Invalid payload schema');
      }

      const { task_id, agent, verdict, notes } = data;

      const latestLaunch = conn()
        .prepare("SELECT status FROM dispatch_launches WHERE task_id = ? ORDER BY launched_at DESC LIMIT 1")
        .get(task_id) as { status: string } | undefined;
        
      // CRITICAL FIX: Check if task cancelled before doing any claims or moving.
      if (latestLaunch?.status === 'cancelled') {
        const invalidPath = path.join(qaProcessedDir, `${filename}.cancelled`);
        fs.renameSync(filePath, invalidPath);
        logActivity({
          agent: agent,
          action: 'dispatch-ignored',
          path: null,
          detail: `Ignored QA file ${filename}: task was stopped/cancelled by user`
        });
        processingFiles.delete(filename);
        return;
      }

      const currentTask = getOrchTask(task_id);
      if (!currentTask) {
        const orphanedPath = path.join(qaProcessedDir, `${filename}.orphaned`);
        fs.renameSync(filePath, orphanedPath);
        logActivity({
          agent: agent || 'system',
          action: 'dispatch-orphaned',
          path: null,
          detail: `Orphaned QA file ${filename}: task #${task_id} was deleted`
        });
        processingFiles.delete(filename);
        return;
      }

      if (currentTask.claimed_by !== agent) {
        const claimResult = claimOrchTaskById(agent, task_id);
        if (claimResult.task?.id !== task_id || claimResult.reason !== 'ok') {
          const invalidPath = path.join(qaProcessedDir, `${filename}.rejected`);
          fs.renameSync(filePath, invalidPath);
          logActivity({
            agent: agent,
            action: 'dispatch-reject',
            path: null,
            detail: `Rejected QA file ${filename}: claim result ${claimResult.reason}`
          });
          closeTaskDispatchLaunches(task_id, 'failed');
          processingFiles.delete(filename);
          return;
        }
      }

      if (dispatchTimers.has(task_id)) {
        clearInterval(dispatchTimers.get(task_id));
        dispatchTimers.delete(task_id);
      }
      if (dispatchAbandonTimers.has(task_id)) {
        clearTimeout(dispatchAbandonTimers.get(task_id));
        dispatchAbandonTimers.delete(task_id);
      }

      reviewOrchTask(task_id, verdict, notes, agent);
      closeTaskDispatchLaunches(task_id, 'done');
      
      try {
        const processedPath = path.join(qaProcessedDir, filename);
        fs.renameSync(filePath, processedPath);
      } catch (err: unknown) {
        logActivity({
          agent,
          action: 'dispatch-error',
          path: null,
          detail: `Work submitted but failed to rename QA file ${filename}: ${err instanceof Error ? err.message : String(err)}`
        });
      }

      processingFiles.delete(filename);
    } catch (err: unknown) {
      try {
        const invalidPath = path.join(qaProcessedDir, `${filename}.invalid`);
        fs.renameSync(filePath, invalidPath);
        let agentStr = 'system';
        if (data && typeof data === 'object' && typeof data.agent === 'string') {
          agentStr = data.agent;
        }
        logActivity({
          agent: agentStr,
          action: 'dispatch-reject',
          path: null,
          detail: `Rejected QA file ${filename}: ${err instanceof Error ? err.message : String(err)}`
        });
      } catch (_) {}
      processingFiles.delete(filename);
    }
  };
  
  tryProcess();
}
