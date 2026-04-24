// reflect/scheduler.ts
// Ported from Python reflect scheduler.
// Simple cron-like scheduler for autonomous task checking.
// Also integrates L4 session compression on a 12-hour schedule.

import { watch, existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { INTERVAL, ONCE, check } from './autonomous';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = resolve(__dirname, '..', '..');

export interface SchedulerAgent {
  put_task(task: string): void;
}

interface ScriptModule {
  INTERVAL?: number;
  ONCE?: boolean;
  check?: () => string;
}

let currentScript: ScriptModule = { INTERVAL, ONCE, check };

/**
 * Watch the reflect script file for changes and hot-reload.
 * Run check() at configured INTERVAL and call agent.put_task()
 * when a new task is returned.
 */
export function createScheduler(scriptPath: string, agent: SchedulerAgent): void {
  const absPath = resolve(scriptPath);
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTask: string | null = null;
  let isRunning = false;

  function loadScript(): void {
    try {
      delete require.cache[require.resolve(absPath)];
      const mod = require(absPath) as ScriptModule;
      currentScript.INTERVAL = mod.INTERVAL || INTERVAL;
      currentScript.ONCE = mod.ONCE !== undefined ? mod.ONCE : ONCE;
      currentScript.check = mod.check || check;
      console.log(`[Scheduler] Script reloaded (interval=${currentScript.INTERVAL}s, once=${currentScript.ONCE})`);
    } catch (e) {
      console.error(`[Scheduler] Failed to load script: ${e}`);
    }
  }

  function runCheck(): void {
    if (isRunning) return;
    isRunning = true;
    try {
      if (currentScript.check) {
        const result = currentScript.check();
        if (result && result !== lastTask) {
          lastTask = result;
          agent.put_task(result);
        }
      }
    } catch (e) {
      console.error(`[Scheduler] check() error: ${e}`);
    } finally {
      isRunning = false;
    }
  }

  function startTimer(): void {
    if (timer) clearInterval(timer);
    const ms = (currentScript.INTERVAL || INTERVAL) * 1000;
    timer = setInterval(runCheck, ms);

    if (currentScript.ONCE) {
      runCheck();
      setTimeout(() => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }, ms + 100);
    }
  }

  // Watch script file for changes and reload
  if (existsSync(absPath)) {
    watch(absPath, (eventType) => {
      if (eventType === 'change') {
        loadScript();
        startTimer();
      }
    });
  }

  loadScript();
  startTimer();
  console.log(`[Scheduler] Started watching ${absPath}`);

  // ── Session compression on 12-hour schedule ──────────────────────────────
  try {
    const { startAutoCompress } = require('../memory/session-compressor');
    const logDir = resolve(scriptDir, 'temp/model_responses');
    startAutoCompress(logDir, 12);
  } catch (e) {
    console.log(`[Scheduler] Session compression not available: ${e}`);
  }
}
