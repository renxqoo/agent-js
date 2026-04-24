#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { GeneraticAgent } from './agent-main.js';
import { runRepl } from './frontends/cli-shell.js';

const program = new Command();

program
  .name('genericagent')
  .description('GenericAgent - TypeScript port')
  .version('1.0.0')
  .option('-c, --chat <message>', 'Send a single message and print the response')
  .option('-t, --task <dir>', 'Task mode: read INPUT.md, write OUTPUT.md (file I/O)')
  .option('--reflect <script>', 'Reflect/monitor mode: run a TypeScript monitor script')
  .option('--input <input>', 'Input for task mode (default: INPUT.md in task dir)')
  .option('--llm-no <n>', 'LLM index to use (number or name)', '0')
  .option('--verbose', 'Verbose output', false)
  .option('--bg', 'Run in background mode (non-interactive)', false)
  .action(async (options) => {
    const agent = new GeneraticAgent();

    // Set verbose mode if requested
    if (options.verbose) {
      console.log('[GeneraticAgent] Verbose mode enabled.');
      console.log(`[GeneraticAgent] Available LLMs: ${agent.listLLMs().join(', ')}`);
    }

    // Start the agent (non-blocking).

    // ─── Handle SIGINT (Ctrl+C) ────────────────────────────────────────────
    let sigintCount = 0;
    const sigintHandler = () => {
      sigintCount += 1;
      if (sigintCount === 1) {
        console.log('\n[GeneraticAgent] Aborting current task... (press Ctrl+C again to force exit)');
        agent.abort();
      } else {
        console.log('\n[GeneraticAgent] Force exiting...');
        process.exit(1);
      }
    };
    process.on('SIGINT', sigintHandler);

    try {
      // ─── Chat Mode ───────────────────────────────────────────────────────
      if (options.chat) {
        const display = agent.putTask(options.chat);
        // Print output chunks as they arrive
        display.on('item', (item: { next?: string; done?: string; source?: string }) => {
          if (item.next) {
            try {
              process.stdout.write(item.next);
            } catch {
              /* stdout pipe may be broken */
            }
          }
          if (item.done) {
            if (item.done !== 'aborted') {
              console.log('\n' + item.done);
            }
          }
        });
        display.on('error', (err: Error) => {
          console.error('\n[Error]', err.message);
        });
        await display.waitForDone();
        return;
      }

      // ─── Task Mode (File I/O) ────────────────────────────────────────────
      if (options.task) {
        await runTaskMode(agent, options.task, options.input, options);
        return;
      }

      // ─── Reflect/Monitor Mode ────────────────────────────────────────────
      if (options.reflect) {
        await runReflectMode(agent, options.reflect, options);
        return;
      }

      // ─── REPL Mode ───────────────────────────────────────────────────────
      // Default: interactive REPL (unless --bg is set, then read from stdin)
      if (options.bg) {
        await runBackgroundMode(agent);
      } else {
        await runRepl(agent);
      }
    } finally {
      process.off('SIGINT', sigintHandler);
    }
  });

program.parse();

// ─── Task Mode Implementation ───────────────────────────────────────────────

async function runTaskMode(
  agent: GeneraticAgent,
  taskDir: string,
  inputFile: string | undefined,
  _options: Record<string, unknown>
): Promise<void> {
  const dir = resolve(process.cwd(), taskDir);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[GeneraticAgent] Created task directory: ${dir}`);
  }

  const inputPath = resolve(dir, inputFile || 'INPUT.md');
  const outputPath = resolve(dir, 'OUTPUT.md');

  if (!existsSync(inputPath)) {
    console.error(`[Error] Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const inputContent = readFileSync(inputPath, 'utf-8');

  console.log(`[GeneraticAgent] Reading task from: ${inputPath}`);
  console.log(`[GeneraticAgent] Output will be written to: ${outputPath}`);

  const display = agent.putTask(inputContent);
  let output = '';

  display.on('item', (item: { next?: string; done?: string; source?: string }) => {
    if (item.next) {
      output += item.next;
      try {
        process.stdout.write(item.next);
      } catch {
        /* stdout pipe may be broken */
      }
    }
    if (item.done && item.done !== 'aborted') {
      output += '\n' + item.done;
      console.log('\n' + item.done);
    }
  });

  display.on('error', (err: Error) => {
    console.error('\n[Error]', err.message);
  });

  await display.waitForDone();

  // Write output file
  writeFileSync(outputPath, output, 'utf-8');
  console.log(`[GeneraticAgent] Output written to: ${outputPath}`);
}

// ─── Reflect Mode Implementation ────────────────────────────────────────────

async function runReflectMode(
  agent: GeneraticAgent,
  scriptPath: string,
  _options: Record<string, unknown>
): Promise<void> {
  const fullPath = resolve(process.cwd(), scriptPath);

  if (!existsSync(fullPath)) {
    console.error(`[Error] Reflect script not found: ${fullPath}`);
    process.exit(1);
  }

  console.log(`[GeneraticAgent] Reflect mode: loading ${fullPath}`);

  try {
    // Dynamic import the reflect script
    const scriptModule = await import(fullPath);
    const monitorFn = scriptModule.default || scriptModule.monitor || scriptModule.run;

    if (typeof monitorFn !== 'function') {
      console.error('[Error] Reflect script must export a default function or monitor/run function.');
      process.exit(1);
    }

    // Run the monitor function, passing the agent
    await monitorFn({ agent });
  } catch (err) {
    console.error('[GeneraticAgent] Reflect script error:', err);
    process.exit(1);
  }
}

// ─── Background Mode Implementation ─────────────────────────────────────────

async function runBackgroundMode(agent: GeneraticAgent): Promise<void> {
  // Read all text from stdin and process it as a single task
  let inputData = '';
  process.stdin.setEncoding('utf-8');

  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  if (!inputData.trim()) {
    console.error('[Error] No input provided in background mode.');
    process.exit(1);
    return;
  }

  console.log(`[GeneraticAgent] Background mode: processing ${inputData.length} chars from stdin.`);

  const display = agent.putTask(inputData.trim());
  let output = '';

  display.on('item', (item: { next?: string; done?: string; source?: string }) => {
    if (item.next) {
      output += item.next;
      try {
        process.stdout.write(item.next);
      } catch {
        /* stdout pipe may be broken */
      }
    }
    if (item.done && item.done !== 'aborted') {
      output += '\n' + item.done;
    }
  });

  display.on('error', (err: Error) => {
    console.error('\n[Error]', err.message);
  });

  await display.waitForDone();
  console.log(); // Final newline
}
