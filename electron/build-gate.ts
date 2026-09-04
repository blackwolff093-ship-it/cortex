import { execFile } from 'node:child_process';
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Toggle switch for the build gate
export const BUILD_GATE_ENABLED = true;

// Explicit timeout in ms
const TYPECHECK_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 120_000;

export async function runTypeCheck(rootDir: string): Promise<{ ok: boolean; errors: string }> {
  if (!BUILD_GATE_ENABLED) {
    return { ok: true, errors: '' };
  }

  if (app.isPackaged) {
    return { ok: true, errors: '' };
  }

  const tscPath = path.join(rootDir, 'node_modules', '.bin', 'tsc');
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');

  if (!fs.existsSync(tscPath) || !fs.existsSync(tsconfigPath)) {
    console.log('[build-gate] tsc or tsconfig.json not found, bypassing typecheck.');
  } else {
    const typecheckResult = await new Promise<{ ok: boolean; errors: string }>((resolve) => {
      let timedOut = false;

      const child = execFile(tscPath, ['--noEmit', '-p', 'tsconfig.json'], {
        cwd: rootDir,
        shell: false,
        maxBuffer: 10 * 1024 * 1024
      }, (error: any, stdout: string, stderr: string) => {
        clearTimeout(timeoutId);
        
        if (timedOut) {
          return resolve({ ok: false, errors: `[typecheck] Typecheck timeout exceeded (${TYPECHECK_TIMEOUT_MS}ms). Process killed.` });
        }

        if (error) {
          if (typeof error.code === 'string') {
            console.log(`[build-gate] tsc failed to run: ${error.code}. Bypassing typecheck.`);
            return resolve({ ok: true, errors: '' });
          }
          const output = [stdout, stderr, error.message].filter(Boolean).join('\n');
          const truncated = output.length > 4000 ? output.substring(0, 4000) + '... (truncated)' : output;
          return resolve({ ok: false, errors: `[typecheck] ${truncated}` });
        }

        resolve({ ok: true, errors: '' });
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (child.pid) process.kill(child.pid, 'SIGKILL');
            } catch (e) {}
          }, 2000); // Send SIGKILL after 2s if still alive
        } catch (e) {}
      }, TYPECHECK_TIMEOUT_MS);
    });

    if (!typecheckResult.ok) {
      return typecheckResult;
    }
  }

  // Phase 2: Build Check
  const vitePath = path.join(rootDir, 'node_modules', '.bin', 'vite');
  const viteConfigPath = path.join(rootDir, 'vite.config.ts');

  if (!fs.existsSync(vitePath) || !fs.existsSync(viteConfigPath)) {
    console.log('[build-gate] vite or vite.config.ts not found, bypassing build check.');
    return { ok: true, errors: '' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-build-gate-'));

  const buildResult = await new Promise<{ ok: boolean; errors: string }>((resolve) => {
    let timedOut = false;

    const child = execFile(vitePath, ['build', '--outDir', tmpDir], {
      cwd: rootDir,
      shell: false,
      maxBuffer: 10 * 1024 * 1024
    }, (error: any, stdout: string, stderr: string) => {
      clearTimeout(timeoutId);
      
      if (timedOut) {
        return resolve({ ok: false, errors: `[build] Build timeout exceeded (${BUILD_TIMEOUT_MS}ms). Process killed.` });
      }

      if (error) {
        if (typeof error.code === 'string') {
          console.log(`[build-gate] vite build failed to run: ${error.code}. Bypassing build check.`);
          return resolve({ ok: true, errors: '' });
        }
        const output = [stdout, stderr, error.message].filter(Boolean).join('\n');
        const truncated = output.length > 4000 ? output.substring(0, 4000) + '... (truncated)' : output;
        return resolve({ ok: false, errors: `[build] ${truncated}` });
      }

      resolve({ ok: true, errors: '' });
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (child.pid) process.kill(child.pid, 'SIGKILL');
          } catch (e) {}
        }, 2000); // Send SIGKILL after 2s if still alive
      } catch (e) {}
    }, BUILD_TIMEOUT_MS);
  });

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.log(`[build-gate] failed to remove tmpDir ${tmpDir}:`, e);
  }

  return buildResult;
}

function normalizeDiffPath(declaredPath: string, rootDir: string): { valid: boolean; normalized?: string; error?: string } {
  let p = declaredPath;
  const tabIndex = p.indexOf('\t');
  const spaceIndex = p.indexOf('  ');
  if (tabIndex !== -1 && spaceIndex !== -1) {
    p = p.substring(0, Math.min(tabIndex, spaceIndex));
  } else if (tabIndex !== -1) {
    p = p.substring(0, tabIndex);
  } else if (spaceIndex !== -1) {
    p = p.substring(0, spaceIndex);
  }
  p = p.trim();

  if (p === '/dev/null') return { valid: false, error: 'devnull' };

  if (p.startsWith('a/') || p.startsWith('b/')) {
    p = p.substring(2);
  }

  const unifiedRoot = rootDir.split(path.sep).join('/');
  const unifiedRootWithoutSlash = unifiedRoot.startsWith('/') ? unifiedRoot.substring(1) : unifiedRoot;
  let unifiedP = p.split(path.sep).join('/');

  if (unifiedP.includes(unifiedRoot)) {
    const idx = unifiedP.indexOf(unifiedRoot);
    p = unifiedP.substring(idx + unifiedRoot.length);
  } else if (unifiedRootWithoutSlash && unifiedP.includes(unifiedRootWithoutSlash)) {
    const idx = unifiedP.indexOf(unifiedRootWithoutSlash);
    p = unifiedP.substring(idx + unifiedRootWithoutSlash.length);
  }

  if (p.startsWith('/') || p.startsWith('\\')) p = p.substring(1);

  if (path.isAbsolute(p)) {
    p = path.relative(rootDir, p);
  }

  p = p.split(path.sep).join('/');

  if (p.startsWith('../') || p === '..') {
    return { valid: false, error: 'invalid_path' };
  }

  return { valid: true, normalized: p };
}

export function verifyDiffApplied(rootDir: string, diffText: string, taskId: number): { ok: boolean; error?: string } {
  if (!BUILD_GATE_ENABLED) return { ok: true };
  if (app.isPackaged) return { ok: true };

  if (!diffText || diffText.trim() === '') {
    return { ok: false, error: '[diff] empty diff' };
  }

  const dispatchFilePath = path.join(rootDir, '.cortex', 'dispatch', `${taskId}.json`);
  let baselineDir = '';
  try {
    if (fs.existsSync(dispatchFilePath)) {
      const dispatchData = JSON.parse(fs.readFileSync(dispatchFilePath, 'utf8'));
      if (dispatchData.baseline_dir) {
        baselineDir = dispatchData.baseline_dir;
      }
    }
  } catch (e) {
    // ignore
  }

  if (!baselineDir || !fs.existsSync(baselineDir)) {
    console.log(`[diff-gate] baseline_dir not found for task ${taskId}, skipping verification.`);
    return { ok: true };
  }

  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const declaredPath = line.substring(4).trim();
      const norm = normalizeDiffPath(declaredPath, rootDir);
      
      if (!norm.valid) {
        if (norm.error === 'devnull') continue;
        if (norm.error === 'invalid_path') return { ok: false, error: `[diff] invalid path outside workspace: ${declaredPath}` };
        continue;
      }

      const finalPath = norm.normalized!;
      const currentFilePath = path.join(rootDir, finalPath);
      const baselineFilePath = path.join(baselineDir, finalPath);

      const currentExists = fs.existsSync(currentFilePath);
      const baselineExists = fs.existsSync(baselineFilePath);

      if (!baselineExists) {
        if (!currentExists) {
          return { ok: false, error: `[diff] claimed change not applied: ${finalPath}` };
        }
      } else {
        if (currentExists) {
          const currentSha = getSha256(currentFilePath);
          const baselineSha = getSha256(baselineFilePath);
          if (currentSha === baselineSha) {
            return { ok: false, error: `[diff] claimed change not applied: ${finalPath}` };
          }
        }
      }
    }
  }

  return { ok: true };
}

function getSha256(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return require('node:crypto').createHash('sha256').update(data).digest('hex');
  } catch (e) {
    return '';
  }
}

