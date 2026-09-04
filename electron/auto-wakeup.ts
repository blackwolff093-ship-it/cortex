import { dbEvents, getPipelineConfig, isTaskDispatchActive, listOrchTasks, getActiveDispatchLaunchesCount, getTaskCooldownTime, MAX_CONCURRENT_DISPATCH } from './db';

let wakeupDebounce: NodeJS.Timeout | null = null;
let globalRootDir = '';
let stdioPath = '';

export function initAutoWakeup(rootDir: string, stdioPathOption: string) {
  globalRootDir = rootDir;
  stdioPath = stdioPathOption;
  
  dbEvents.on('change', (e: { type?: string }) => {
    if (e?.type !== 'orchestrator') return;
    if (wakeupDebounce) clearTimeout(wakeupDebounce);
    wakeupDebounce = setTimeout(() => {
      wakeupDebounce = null;
      void checkAutoWakeup();
    }, 1500);
  });
  // Kick off an initial pass
  setTimeout(() => void checkAutoWakeup(), 2000);
}

export async function checkAutoWakeup() {
  if (!stdioPath) return; // not initialized
  
  if (getActiveDispatchLaunchesCount() >= MAX_CONCURRENT_DISPATCH) return; // strict cap of 1 global launch
  
  const tasks = listOrchTasks(100);
  const pipeline = getPipelineConfig();
  const roleMap = new Map(pipeline.map(r => [r.role_key, r]));
  
  // Find the oldest eligible task (since tasks are usually returned by id/created_at, we can just sort by id or created_at)
  // listOrchTasks usually returns newest first if it's descending. Let's make sure we find the OLDEST eligible one.
  const eligibleTasks = [];
  
  for (const task of tasks) {
    if (task.status === 'FAILED' || task.status === 'COMPLETED') continue;
    if (task.gate_pending) continue;
    if (task.claimed_by) continue; // Already claimed/active
    if (task.auto_blocked) continue; // Manually blocked by user
    
    const role = roleMap.get(task.current_role);
    if (!role || !role.is_enabled || !role.auto_dispatch) continue;
    
    if (role.assigned_agent !== 'antigravity' && role.assigned_agent !== 'claude') continue;
    
    if (isTaskDispatchActive(task.id)) continue;
    
    // Cooldown check for recently failed tasks
    if (Date.now() - getTaskCooldownTime(task.id) < 2 * 60 * 1000) continue; // 2 minutes cooldown
    
    eligibleTasks.push(task);
  }
  
  if (eligibleTasks.length === 0) return;
  
  // Sort to get the oldest task
  eligibleTasks.sort((a, b) => a.created_at - b.created_at);
  const taskToLaunch = eligibleTasks[0];
  
  try {
    const { dispatchTask } = await import('./agentapi');
    await dispatchTask(taskToLaunch.id, taskToLaunch.current_role, globalRootDir, stdioPath);
  } catch (e) {
    console.error(`Auto wakeup failed for task ${taskToLaunch.id}:`, e);
  }
}
