export const dispatchTimers = new Map<number, NodeJS.Timeout>();
export const dispatchAbandonTimers = new Map<number, NodeJS.Timeout>();

/** Live child processes per task, so stopOrchTask can actually kill a run.
 *  Registered by the launchers; deleted when the process exits. */
export const dispatchChildren = new Map<number, { kill: (sig?: NodeJS.Signals) => void }>();
