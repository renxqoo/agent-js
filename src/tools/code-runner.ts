import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { resolve, dirname, basename } from 'path';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

// ─── smartFormat ────────────────────────────────────────────────────────────

/**
 * Truncate a string to the given maximum length, keeping a middle section omitted.
 * Keeps the first half and the last half of the content.
 */
export function smartFormat(
  data: unknown,
  maxStrLen: number = 100,
  omitStr: string = ' ... '
): string {
  const s = typeof data === 'string' ? data : String(data);
  if (s.length < maxStrLen + omitStr.length * 2) return s;
  return s.slice(0, Math.floor(maxStrLen / 2)) + omitStr + s.slice(-Math.floor(maxStrLen / 2));
}

// ─── codeRun ────────────────────────────────────────────────────────────────

/**
 * Code executor.  Port of Python code_run.
 *
 * python: runs complex .py scripts (file mode)
 * powershell/bash: runs a single command (command mode)
 * Prefer python; only use powershell/bash for necessary system operations.
 *
 * Yields streaming status/result lines, returning a final result object:
 *   { status: "success" | "error", stdout: string, exit_code: number | null }
 */
export async function* codeRun(
  code: string,
  codeType: string = 'python',
  timeout: number = 60,
  cwd?: string,
  codeCwd?: string,
  stopSignal: number[] = []
): AsyncGenerator<string, Record<string, unknown>> {
  // Build preview snippet
  const preview =
    code.length > 60
      ? code.slice(0, 60).replace(/\n/g, ' ') + '...'
      : code.trim();

  yield `[Action] Running ${codeType} in ${basename(cwd || process.cwd())}: ${preview}\n`;

  const workDir = cwd || resolve(scriptDir, 'temp');
  let tmpPath: string | null = null;
  let cmd: string;
  let args: string[];

  // ── Determine command / args ──────────────────────────────────────────────
  const lowerType = codeType.toLowerCase();

  if (lowerType === 'python' || lowerType === 'py') {
    // Write code to a temp file, optionally prefixing the run header
    const tmpDir = codeCwd || mkdtempSync(resolve(tmpdir(), 'ga-py-'));
    tmpPath = resolve(tmpDir, `script_${Date.now()}.ai.py`);
    const headerPath = resolve(scriptDir, 'assets', 'code_run_header.py');

    let headerContent = '';
    if (existsSync(headerPath)) {
      try {
        headerContent = readFileSync(headerPath, 'utf-8');
      } catch {
        /* ignore missing / unreadable header */
      }
    }

    writeFileSync(tmpPath, headerContent + '\n' + code, 'utf-8');
    cmd = 'python3';
    args = ['-u', tmpPath];
  } else if (['powershell', 'ps1', 'pwsh'].includes(lowerType)) {
    if (process.platform === 'win32') {
      cmd = 'powershell';
      args = ['-NoProfile', '-NonInteractive', '-Command', code];
    } else {
      // pwsh on non-Windows
      cmd = 'pwsh';
      args = ['-NoProfile', '-NonInteractive', '-Command', code];
    }
  } else if (['bash', 'sh', 'shell'].includes(lowerType)) {
    cmd = 'bash';
    args = ['-c', code];
  } else {
    return {
      status: 'error',
      msg: `Unsupported type: ${codeType}`,
    };
  }

  // ── Collect stdout ────────────────────────────────────────────────────────
  const stdoutLines: string[] = [];

  let proc: ChildProcess | null = null;

  try {
    proc = spawn(cmd, args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],   // stdin=ignore, stdout=pipe, stderr=pipe
      env: { ...process.env },
    });

    const startTime = Date.now();

    // stderr goes into the same buffer so the caller sees everything
    proc.stderr?.on('data', (data: Buffer) => {
      const text = decodeBuffer(data);
      stdoutLines.push(text);
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const text = decodeBuffer(data);
      stdoutLines.push(text);
    });

    // Wait for the process to finish OR hit timeout / stop signal
    const exitCode = await new Promise<number | null>((resolveExit) => {
      // Timeout / stop-signal check
      const interval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed >= timeout || stopSignal.length > 0) {
          clearInterval(interval);
          if (proc && !proc.killed) {
            proc.kill('SIGKILL');
          }
          if (elapsed >= timeout) {
            stdoutLines.push('\n[Timeout Error] Timeout force-terminated');
          } else {
            stdoutLines.push('\n[Stopped] User force-terminated');
          }
          resolveExit(null);
        }
      }, 1000);

      const onClose = (code: number | null) => {
        clearInterval(interval);
        resolveExit(code);
      };

      const onError = (err: Error) => {
        clearInterval(interval);
        stdoutLines.push(`\n[Process Error] ${err.message}`);
        resolveExit(null);
      };

      proc?.once('close', onClose);
      proc?.once('error', onError);
    });

    // ── Build result ────────────────────────────────────────────────────────
    const stdoutStr = stdoutLines.join('');
    const status = exitCode === 0 ? 'success' : 'error';
    const statusIcon = exitCode === 0 ? 'ok' : 'X';
    const finalIcon = exitCode === null ? '~' : statusIcon;

    const outputSnippet = smartFormat(stdoutStr, 600, '\n\n[omitted long output]\n\n');
    yield `[Status] ${finalIcon} Exit Code: ${exitCode}\n[Stdout]\n${outputSnippet}\n`;

    return {
      status,
      stdout: smartFormat(stdoutStr, 10000, '\n\n[omitted long output]\n\n'),
      exit_code: exitCode,
    };
  } catch (e) {
    if (proc && !proc.killed) proc.kill('SIGKILL');
    return {
      status: 'error',
      msg: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // Clean up temp file for python
    if (lowerType === 'python' && tmpPath && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ─── decodeBuffer ───────────────────────────────────────────────────────────

function decodeBuffer(data: Buffer): string {
  try {
    return data.toString('utf-8');
  } catch {
    try {
      return data.toString('latin1');
    } catch {
      return String(data);
    }
  }
}
