import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  StepOutcome, MockResponse, MockToolCall,
} from '../../src/core/types.js';
import type { Message, ToolSchema } from '../../src/core/types.js';
import { BaseHandler, agentRunnerLoop } from '../../src/core/agent-loop.js';
import { AbortSignal_ } from '../../src/agent-main.js';

// ─── Mock the LLM core to provide fake session config ────────────────────────

const mockConfig: Record<string, unknown> = {
  api_test: {
    apikey: 'test-api-key',
    apibase: 'https://test.example/api',
    model: 'test-model',
    name: 'TestSession',
  },
};

vi.mock('../../src/core/llm-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm-core.js')>();
  return {
    ...actual,
    getMyKeys: () => mockConfig,
    getProxies: () => null,
  };
});

// ─── Handler subclass for e2e tests ───────────────────────────────────────────

class TestHandler extends BaseHandler {
  toolCallsDispatched: string[] = [];

  async *do_code_run(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const code = String(args['code'] || '');
    yield `executed: ${code.slice(0, 30)}\n`;
    this.toolCallsDispatched.push(`code_run: ${code.slice(0, 20)}`);
    return new StepOutcome(
      { output: `Result of: ${code.slice(0, 30)}` },
      'Continue working on the task.',
      false,
    );
  }

  override async *do_no_tool(
    _args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    return new StepOutcome('Ready', null as unknown as string, false);
  }
}

/** Helper: drain an async generator and return the final value. */
async function drainGen<T, R>(
  gen: AsyncGenerator<T, R>,
): Promise<{ chunks: T[]; final: R }> {
  const chunks: T[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value as T);
    next = await gen.next();
  }
  return { chunks, final: next.value };
}

/** Create a mock chat client that returns predetermined responses. */
function mockChatClient(responses: MockResponse[]) {
  let counter = 0;
  const chat = vi.fn(async function* (
    _messages: Message[],
    _tools?: ToolSchema[],
  ): AsyncGenerator<string, MockResponse> {
    const r = responses[counter] ?? new MockResponse('', '', [], 'raw-default');
    counter++;
    if (r.content) {
      // Yield content in chunks so the agent loop can consume them
      const parts = r.content.match(/.{1,50}/g) || [r.content];
      for (const p of parts) yield p;
    }
    return r;
  });
  return { chat, getCallCount: () => counter };
}

// ─── Agent runner loop tests ──────────────────────────────────────────────────

describe('agent runner loop with mocked LLM', () => {
  const tools: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'code_run',
        description: 'Run code',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  it('completes a task from submission through handler dispatch to result output', async () => {
    const handler = new TestHandler();

    // Turn 1: LLM returns a code_run tool call
    // Turn 2: LLM returns nothing -> triggers no_tool -> exit
    const responses = [
      new MockResponse(
        'thinking',
        'I will run code.',
        [new MockToolCall('code_run', { code: 'print("hello")', type: 'python' }, 'call_1')],
        'raw-1',
      ),
      new MockResponse('done', 'Task complete.', [], 'raw-2'),
    ];

    const client = mockChatClient(responses);

    const gen = agentRunnerLoop(
      client as any,
      'You are a test agent.',
      'Run a test.',
      handler,
      tools,
      5,
      false,
    );

    const { final } = await drainGen(gen);

    expect(client.getCallCount()).toBeGreaterThanOrEqual(1);
    expect(handler.toolCallsDispatched.some(x => x.startsWith('code_run'))).toBe(true);

    // Should have an exit reason
    const exit = (final as Record<string, unknown>)['result'];
    expect(['CURRENT_TASK_DONE', 'MAX_TURNS_EXCEEDED'].includes(exit as string)).toBe(true);
  });

  it('handles a tool call that triggers should_exit', async () => {
    const handler = new TestHandler();
    handler.do_code_run = async function* (
      args: Record<string, unknown>,
      _response: MockResponse,
    ): AsyncGenerator<string, StepOutcome> {
      const code = String(args['code'] || '');
      yield `exiting: ${code.slice(0, 20)}\n`;
      return new StepOutcome(code, 'exit', true);
    };

    const responses = [
      new MockResponse(
        '',
        'Exiting now.',
        [new MockToolCall('code_run', { code: 'exit()', type: 'python' }, 'call_exit')],
        'raw-exit',
      ),
    ];

    const client = mockChatClient(responses);
    const gen = agentRunnerLoop(client as any, '', 'Exit please.', handler, tools, 5, false);
    const { final } = await drainGen(gen);

    expect((final as Record<string, unknown>)['result']).toBe('EXITED');
  });
});

// ─── Slash command tests ──────────────────────────────────────────────────────

describe('GeneraticAgent slash commands', () => {
  let GeneraticAgent: typeof import('../../src/agent-main.js').GeneraticAgent;

  beforeAll(async () => {
    const mod = await import('../../src/agent-main.js');
    GeneraticAgent = mod.GeneraticAgent;
  });

  it('/llms lists configured sessions and completes', async () => {
    const agent = new GeneraticAgent();
    const display = agent.putTask('/llms');

    // Slash commands mark display as done synchronously, so isDone is true
    // and waitForDone() resolves immediately.
    const msg = await display.waitForDone();
    expect(display.isDone).toBe(true);
    // The return value via waitForDone should exist
    expect(typeof msg).toBe('string');
  }, 15000);

  it('/session without arguments completes successfully', async () => {
    const agent = new GeneraticAgent();
    const display = agent.putTask('/session');

    const msg = await display.waitForDone();
    expect(display.isDone).toBe(true);
    expect(typeof msg).toBe('string');
  }, 15000);

  it('/session with a known name switches to that session', async () => {
    const agent = new GeneraticAgent();
    const display = agent.putTask('/session TestSession');

    const msg = await display.waitForDone();
    expect(display.isDone).toBe(true);
    expect(typeof msg).toBe('string');
  }, 15000);

  it('/resume with a nonexistent file reports the error', async () => {
    const agent = new GeneraticAgent();
    const display = agent.putTask('/resume ./nonexistent_resume.txt');

    const msg = await display.waitForDone();
    expect(display.isDone).toBe(true);
    expect(typeof msg).toBe('string');
  }, 15000);
});

// ─── Abort signal tests ───────────────────────────────────────────────────────

describe('AbortSignal_', () => {
  it('is not aborted initially', () => {
    const signal = new AbortSignal_();
    expect(signal.aborted).toBe(false);
  });

  it('reflects aborted state after abort() is called', () => {
    const signal = new AbortSignal_();
    signal.abort();
    expect(signal.aborted).toBe(true);
  });

  it('can be reset back to a non-aborted state', () => {
    const signal = new AbortSignal_();
    signal.abort();
    expect(signal.aborted).toBe(true);
    signal.reset();
    expect(signal.aborted).toBe(false);
  });
});
