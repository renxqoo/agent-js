import { StepOutcome, MockResponse, getPrettyJson } from '../core/types.js';
import type { Message, ToolCallRecord, ToolResult, ToolSchema } from '../core/types.js';
import type { ToolClient } from '../core/llm-core.js';
import { startToolCall, endToolCall } from '../plugins/langfuse-tracing.js';

// ─── Helper: exhaust async generator, returning its final value ─────────────

/**
 * Drain an async generator completely without consuming intermediate yields.
 * Returns the final return value of the generator (the value at done === true).
 */
export async function exhaustGen<T, R>(
  gen: AsyncGenerator<T, R>,
): Promise<R> {
  let result: IteratorResult<T, R>;
  while (!(result = await gen.next()).done) {
    /* drain – intentionally empty */
  }
  return result.value;
}

// ─── Helper: try_call_generator ─────────────────────────────────────────────

/**
 * Call `func` with the given arguments. If the return value is itself an
 * AsyncGenerator, delegate to it via `yield*` (caller must be inside an async
 * generator). Otherwise return the plain value directly.
 *
 * IMPORTANT: Because this uses `yield*`, it MUST only be invoked from within an
 * `async function*` context. When called from a plain async function the thrown
 * return value is retrieved via .next() on the outer generator.
 */
async function* tryCallGenerator<T>(
  func: (...args: any[]) => T | AsyncGenerator<any, T> | Promise<T | AsyncGenerator<any, T>>,
  ...args: any[]
): AsyncGenerator<string, T> {
  const ret = func(...args);
  const awaited = ret instanceof Promise ? await ret : ret;
  if (
    awaited &&
    typeof awaited === 'object' &&
    Symbol.asyncIterator in Object(awaited)
  ) {
    return yield* (awaited as AsyncGenerator<any, T>);
  }
  return awaited as T;
}

// ─── Helper: _clean_content ─────────────────────────────────────────────────

function _cleanContent(content: string): string {
  // Strip think/thinking tags
  return content
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '')
    .replace(/<talk_chat>[\s\S]*?<\/talk_chat>/gs, '')
    .trim();
}

// ─── Helper: _compact_tool_args ─────────────────────────────────────────────

function _compactToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const FILESIZE_TOOLS = new Set([
    'file_read', 'file_patch', 'file_write', 'code_run',
  ]);

  if (FILESIZE_TOOLS.has(toolName) || toolName.startsWith('image_')) {
    const compact = { ...args };
    for (const k of Object.keys(compact)) {
      const v = compact[k];
      if (typeof v === 'string' && v.length > 200) {
        compact[k] = `...${v.slice(-200)}`;
      }
    }
    return JSON.stringify(compact);
  }
  return JSON.stringify(args);
}

// ─── BaseHandler ────────────────────────────────────────────────────────────

export class BaseHandler {
  max_turns: number = 40;
  current_turn: number = 0;
  _done_hooks: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tool_before_callback(
    _tool_name: string,
    _args: Record<string, unknown>,
    _response: MockResponse,
  ): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tool_after_callback(
    _tool_name: string,
    _args: Record<string, unknown>,
    _response: MockResponse,
    _ret: StepOutcome,
  ): void {}

  /**
   * Default handler for when the LLM produces no tool calls.
   * Subclasses should override this for plan-mode / done-hook logic.
   */
  async *do_no_tool(
    _args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    return new StepOutcome(
      'Ready',
      null as unknown as string,
      false,
    );
  }

  /**
   * Called at the end of every turn. Returns the (possibly modified) prompt
   * for the next assistant turn. Override in subclasses to inject context,
   * history, anchor prompts, etc.
   */
  turn_end_callback(
    _response: MockResponse,
    _tool_calls: ToolCallRecord[],
    _tool_results: ToolResult[],
    _turn: number,
    next_prompt: string,
    _exit_reason: Record<string, unknown>,
  ): string {
    return next_prompt;
  }

  /**
   * Dispatch a tool call to the appropriate `do_<tool_name>` method.
   *
   * 1. Calls tool_before_callback (may be a generator).
   * 2. Calls `this.do_<tool_name>(args, response)` (must be an async generator).
   * 3. Calls tool_after_callback.
   * 4. Returns the StepOutcome.
   */
  async *dispatch(
    tool_name: string,
    args: Record<string, unknown>,
    response: MockResponse,
    index: number = 0,
  ): AsyncGenerator<string, StepOutcome> {
    const methodName = `do_${tool_name}`;

    if (typeof (this as any)[methodName] === 'function') {
      args['_index'] = index;

      // tool_before_callback (may or may not be a generator)
      yield* tryCallGenerator(
        this.tool_before_callback.bind(this),
        tool_name,
        args,
        response,
      );

      // Langfuse: start tool call span
      const toolSpan = startToolCall(tool_name, args);

      let ret: StepOutcome;
      let dispatchError: string | undefined;
      try {
        // The actual do_* method – always an async generator
        const func = (this as any)[methodName].bind(this);
        ret = (yield* tryCallGenerator(func, args, response)) as unknown as StepOutcome;
      } catch (e) {
        dispatchError = String(e);
        throw e;
      } finally {
        // Langfuse: end tool call span (ensured even on error)
        endToolCall(
          toolSpan,
          !dispatchError && ret!?.data
            ? (typeof ret!.data === 'string' ? ret!.data : JSON.stringify(ret!.data))
            : '',
          dispatchError,
        );
      }

      // tool_after_callback
      yield* tryCallGenerator(
        this.tool_after_callback.bind(this),
        tool_name,
        args,
        response,
        ret,
      );

      return ret;
    }

    if (tool_name === 'bad_json') {
      return new StepOutcome(
        null,
        (args['msg'] as string) || 'bad_json',
        false,
      );
    }

    // Unknown tool
    yield `Unknown tool: ${tool_name}\n`;
    return new StepOutcome(null, `Unknown tool ${tool_name}`, false);
  }
}

// ─── agentRunnerLoop ────────────────────────────────────────────────────────

/**
 * The main agent execution loop.
 *
 * Parameters
 * ----------
 * client       – ToolClient | NativeToolClient with a `.chat()` async generator.
 * system_prompt – system-level instruction.
 * user_input    – the initial user request.
 * handler      – a BaseHandler subclass instance that implements do_* methods.
 * tools_schema – tool definitions passed to the LLM.
 * max_turns    – safety limit on the number of LLM turns.
 * verbose      – when true, streams intermediate output to the caller.
 * initial_user_content – optionally override the first user message content.
 */
export async function* agentRunnerLoop(
  client: { chat: (messages: Message[], tools?: ToolSchema[]) => AsyncGenerator<string, MockResponse> },
  system_prompt: string,
  user_input: string,
  handler: BaseHandler,
  tools_schema: ToolSchema[],
  max_turns: number = 40,
  verbose: boolean = true,
  initial_user_content: string | null = null,
): AsyncGenerator<string, Record<string, unknown>> {
  let messages: Message[] = [
    { role: 'system', content: system_prompt },
    {
      role: 'user',
      content:
        initial_user_content !== null ? initial_user_content : user_input,
    },
  ];

  let turn = 0;
  handler.max_turns = max_turns;

  let response: MockResponse = new MockResponse('', '', [], '');
  let toolCalls: ToolCallRecord[] = [];
  let exitReason: Record<string, unknown> = {};

  while (turn < handler.max_turns) {
    turn += 1;
    const md = verbose ? '**' : '';
    yield `${md}LLM Running (Turn ${turn}) ...${md}\n\n`;

    // Periodically reset last-tools cache to force full tool re-emission
    if (turn % 10 === 0 && 'lastTools' in client) {
      (client as ToolClient).lastTools = '';
    }

    // ── Call LLM ──────────────────────────────────────────────────────────
    const chatGen = client.chat(messages, tools_schema);

    if (verbose) {
      response = yield* chatGen;
      yield '\n\n';
    } else {
      response = await exhaustGen(chatGen);
      const cleaned = _cleanContent(response.content);
      if (cleaned) yield cleaned + '\n';
    }

    // ── Build tool-call list ──────────────────────────────────────────────
    if (!response.tool_calls || response.tool_calls.length === 0) {
      toolCalls = [{ tool_name: 'no_tool', args: {} }];
    } else {
      toolCalls = response.tool_calls.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { _raw: tc.function.arguments, _error: 'Failed to parse tool arguments' };
        }
        return {
          tool_name: tc.function.name,
          args,
          id: tc.id,
        };
      });
    }

    // ── Dispatch each tool call ───────────────────────────────────────────
    const toolResults: ToolResult[] = [];
    const nextPrompts = new Set<string>();
    exitReason = {};

    for (let ii = 0; ii < toolCalls.length; ii++) {
      const tc = toolCalls[ii];
      const toolName = tc.tool_name;
      const args = tc.args;
      const tid = tc.id || '';

      if (toolName === 'no_tool') {
        // handled later via _done_hooks / plan-mode logic
      } else {
        if (verbose) {
          yield `Tool: \`${toolName}\`  args:\n\`\`\`\`text\n${getPrettyJson(args)}\n\`\`\`\`\n`;
        } else {
          yield `${toolName}(${_compactToolArgs(toolName, args)})\n\n\n`;
        }
      }

      handler.current_turn = turn;
      const dispatchGen = handler.dispatch(toolName, args, response, ii);

      let outcome: StepOutcome;
      const firstResult = await dispatchGen.next();

      if (firstResult.done) {
        // dispatch returned without yielding any intermediate text
        outcome = firstResult.value as StepOutcome;
      } else {
        // There was intermediate yielded text – proxy the rest
        async function* proxy(): AsyncGenerator<string, StepOutcome> {
          yield firstResult.value as string;
          return yield* dispatchGen;
        }

        if (verbose) {
          yield '`````\n';
          outcome = yield* proxy();
          yield '`````\n';
        } else {
          outcome = await exhaustGen(proxy());
        }
      }

      // ── Process outcome ────────────────────────────────────────────────
      if (outcome.should_exit) {
        exitReason = { result: 'EXITED', data: outcome.data };
        break;
      }
      if (!outcome.next_prompt) {
        exitReason = { result: 'CURRENT_TASK_DONE', data: outcome.data };
        break;
      }
      if (outcome.next_prompt.startsWith('Unknown tool')) {
        if ('lastTools' in client) {
          (client as ToolClient).lastTools = '';
        }
      }
      if (outcome.data !== null && toolName !== 'no_tool') {
        const datastr =
          typeof outcome.data === 'object' && outcome.data !== null
            ? JSON.stringify(outcome.data)
            : String(outcome.data);
        toolResults.push({ tool_use_id: tid, content: datastr });
      }
      nextPrompts.add(outcome.next_prompt);
    }

    // ── Determine next prompt / exit ─────────────────────────────────────
    if (nextPrompts.size === 0 || Object.keys(exitReason).length > 0) {
      if (
        handler._done_hooks.length === 0 ||
        exitReason['result'] === 'EXITED'
      ) {
        break;
      }
      nextPrompts.add(handler._done_hooks.shift()!);
    }

    const rawNextPrompt = [...nextPrompts].join('\n');
    const nextPrompt = handler.turn_end_callback(
      response,
      toolCalls,
      toolResults,
      turn,
      rawNextPrompt,
      exitReason,
    );

    messages = [
      {
        role: 'user',
        content: nextPrompt,
        tool_results: toolResults,
      },
    ];
  }

  // Final callback
  if (Object.keys(exitReason).length > 0) {
    handler.turn_end_callback(
      response,
      toolCalls || [],
      [],
      turn,
      '',
      exitReason,
    );
  }
  return exitReason || { result: 'MAX_TURNS_EXCEEDED' };
}
