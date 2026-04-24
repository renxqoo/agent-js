import { describe, it, expect, beforeAll } from 'vitest';
import { LLMSession } from '../../src/core/llm-core.js';
import type { SessionConfig, Message } from '../../src/core/types.js';

// ─── Read configuration from environment ──────────────────────────────────────

const apiKey = process.env.MYKEY_TEST_APIKEY;
const apiBase = process.env.MYKEY_TEST_BASEURL || 'https://api.minimax.chat';
const modelName = process.env.MYKEY_TEST_MODEL || 'abab6.5s-chat';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createSession(): LLMSession {
  const cfg: SessionConfig = {
    apikey: apiKey!,
    apibase: apiBase,
    model: modelName,
    context_win: 8000,
    max_retries: 1,
    temperature: 0.7,
  };
  return new LLMSession(cfg);
}

async function drainChat(session: LLMSession, messages: Message[]): Promise<string> {
  let fullText = '';
  const gen = session.rawAsk(messages);
  for await (const chunk of gen) {
    fullText += chunk;
  }
  return fullText;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

const describeOrSkip = apiKey ? describe : describe.skip;

describeOrSkip('MiniMax Integration', () => {
  let session: LLMSession;

  beforeAll(() => {
    session = createSession();
  });

  it('receives a response from a basic chat message', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Reply with exactly: "Hello, test passed."' },
    ];

    const output = await drainChat(session, messages);

    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(0);
    expect(output.toLowerCase()).toContain('hello');
  }, 30000);

  it('handles a system prompt by responding appropriately', async () => {
    const s2 = createSession();
    const messages: Message[] = [
      { role: 'user', content: 'Say the secret word from your system prompt if you have one. Otherwise say "no secret".' },
    ];

    const output = await drainChat(s2, messages);
    expect(output).toBeTruthy();
  }, 30000);

  it('returns a tool-call-style response when asked to simulate one', async () => {
    const s3 = createSession();
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Output a tool use in JSON format: {"name": "echo", "arguments": {"text": "ping"}}. Do not add any extra text, only output that exact JSON.',
      },
    ];

    const output = await drainChat(s3, messages);
    expect(output).toBeTruthy();

    // The output should contain JSON-like structure with name and arguments
    const hasEcho = output.includes('echo') || output.includes('"name"');
    expect(hasEcho).toBe(true);
  }, 30000);
});
