import * as readline from 'readline';
import type { GeneraticAgent } from '../agent-main.js';

/**
 * Run the interactive REPL for GenericAgent.
 *
 * Provides a command-line interface where users can type queries
 * and see streaming responses. Supports:
 *   - Ctrl+C to abort the current task
 *   - Ctrl+D to exit
 *   - Slash commands (e.g., /session, /resume, /llms)
 *   - Multi-line input continuation with backslash
 *
 * @param agent The GeneraticAgent instance.
 */
export async function runRepl(agent: GeneraticAgent): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36mGA> \x1b[0m', // Cyan prompt
    terminal: true,
  });

  // Track whether we're currently processing a task
  let busy = false;
  // Buffer for multi-line input
  let multiLineBuffer: string[] = [];
  let inMultiLine = false;

  // Custom prompt for multi-line
  const CONTINUE_PROMPT = '\x1b[36m..  \x1b[0m';

  console.log('GenericAgent REPL. Type your query and press Enter.');
  console.log('  Ctrl+C  - Abort current task');
  console.log('  Ctrl+D  - Exit');
  console.log('  \\       - Continue on next line (multi-line input)');
  console.log('  /session - Show or switch sessions');
  console.log('  /llms    - List available LLMs');
  console.log('  /resume <file> - Resume from log file');
  console.log('  /help    - Show this help');
  console.log('');

  rl.prompt();

  // ─── Handle line input ──────────────────────────────────────────────────
  rl.on('line', async (line: string) => {
    const trimmed = line.trimEnd();

    // Check for multi-line continuation
    if (trimmed.endsWith('\\') && !trimmed.endsWith('\\\\')) {
      inMultiLine = true;
      multiLineBuffer.push(trimmed.slice(0, -1));
      rl.setPrompt(CONTINUE_PROMPT);
      rl.prompt();
      return;
    }

    // Handle escaped backslash (\\)
    let input: string;
    if (inMultiLine) {
      multiLineBuffer.push(trimmed);
      input = multiLineBuffer.join('\n');
      multiLineBuffer = [];
      inMultiLine = false;
      rl.setPrompt('\x1b[36mGA> \x1b[0m');
    } else {
      input = trimmed;
    }

    // Skip empty input
    if (!input.trim()) {
      rl.prompt();
      return;
    }

    // Handle /help command locally
    if (input.trim() === '/help') {
      console.log('');
      console.log('GenericAgent Commands:');
      console.log('  /session        - Show current session');
      console.log('  /session=NAME   - Switch to named session');
      console.log('  /session=N      - Switch to session at index N');
      console.log('  /llms           - List all available LLMs');
      console.log('  /resume <file>  - Resume a task from a log file');
      console.log('  /history        - Show recent task history');
      console.log('  /exit, /quit    - Exit the REPL');
      console.log('');
      rl.prompt();
      return;
    }

    // Handle exit commands
    if (input.trim() === '/exit' || input.trim() === '/quit') {
      console.log('Goodbye.');
      rl.close();
      return;
    }

    // Handle /history
    if (input.trim() === '/history') {
      const history = agent.history;
      if (history.length === 0) {
        console.log('No history yet.');
      } else {
        console.log('Recent history:');
        for (let i = 0; i < history.length; i++) {
          console.log(`  ${i + 1}. ${history[i].slice(0, 120)}${history[i].length > 120 ? '...' : ''}`);
        }
      }
      rl.prompt();
      return;
    }

    // Mark as busy
    busy = true;

    // Add to history
    agent.history.unshift(input.trim());
    if (agent.history.length > 100) {
      agent.history.length = 100;
    }

    // Submit the task
    const display = agent.putTask(input.trim());

    // ─── Display output chunks ────────────────────────────────────────────
    let lastWasNewline = false;
    let contentStarted = false;

    display.on('item', (item: { next?: string; done?: string; source?: string }) => {
      if (item.next) {
        if (!contentStarted) {
          console.log(''); // Blank line before response
          contentStarted = true;
        }
        process.stdout.write(item.next);
        lastWasNewline = item.next.endsWith('\n');
      }
      if (item.done) {
        if (contentStarted && !lastWasNewline) {
          console.log('');
        }
        if (item.done !== 'aborted') {
          console.log(item.done);
        }
        console.log(''); // Blank line after response
      }
    });

    display.on('error', (err: Error) => {
      if (!contentStarted) {
        console.log('');
      }
      console.error('\x1b[31m[Error]\x1b[0m', err.message);
      console.log('');
    });

    display.on('done', () => {
      busy = false;
      contentStarted = false;
      rl.prompt();
    });
  });

  // ─── Handle Ctrl+D / close ──────────────────────────────────────────────
  rl.on('close', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });

  // ─── Handle Ctrl+C via SIGINT ───────────────────────────────────────────
  // The SIGINT handler in index.ts handles the first Ctrl+C.
  // We add a REPL-level listener for re-prompting after abort.
  let wasAborting = false;

  const sigintHandler = () => {
    if (busy && !wasAborting) {
      wasAborting = true;
      console.log('\n\x1b[33m[Aborting... press Ctrl+C again to force exit]\x1b[0m');
      agent.abort();
      // Reset after a short delay
      setTimeout(() => {
        wasAborting = false;
        busy = false;
        rl.prompt();
      }, 500);
    }
  };

  process.on('SIGINT', sigintHandler);

  // Also listen for agent-level abort events
  agent.on('abort', () => {
    if (busy) {
      busy = false;
    }
  });

  // Cleanup on close
  rl.on('close', () => {
    process.off('SIGINT', sigintHandler);
  });
}
