// plugins/langfuse-tracing.ts
// Full Langfuse tracing integration using the langfuse v3 SDK.
// Provides explicit trace/span/generation architecture:
//   Agent Task (trace) → LLM Generation → Tool Call (span)
//
// Setup:
//   1. pnpm add langfuse
//   2. Set env vars: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
//   3. Call initLangfuse() on startup; the agent loop auto-instruments calls.

// ─── Module-level state ─────────────────────────────────────────────────────

let _client: import('langfuse').Langfuse | null = null;
let _initialized = false;
let _sampleRate: number = 1.0;

// Current active agent trace
let _currentTrace: any = null;

// Current LLM generation (for nesting tool spans under)
let _currentGeneration: any = null;

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize Langfuse tracing.
 * Requires LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY env vars.
 * LANGFUSE_HOST defaults to https://cloud.langfuse.com.
 */
export function initLangfuse(config?: Record<string, unknown>): void {
  if (_initialized) return;

  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];

  if (!publicKey || !secretKey) {
    console.log('[Langfuse] Skipping – LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set');
    return;
  }

  _sampleRate = parseFloat(process.env['LANGFUSE_SAMPLE_RATE'] || '1.0');

  try {
    const { Langfuse } = require('langfuse') as typeof import('langfuse');
    _client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: (process.env['LANGFUSE_HOST'] as string) || 'https://cloud.langfuse.com',
      ...config,
    });
    _initialized = true;
    console.log('[Langfuse] Initialized – tracing enabled');
  } catch (err) {
    console.log(`[Langfuse] Init failed (missing SDK?): ${err}`);
  }
}

/**
 * Shutdown Langfuse – flushes pending traces. Call before process exit.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (_client) {
    await _client.shutdownAsync();
    _client = null;
  }
  _initialized = false;
}

/** Whether tracing is currently active (configured + within sample rate). */
export function isTracing(): boolean {
  return _initialized && _client !== null && Math.random() < _sampleRate;
}

/**
 * Get a trace URL for debugging.
 */
export function getTraceUrl(traceId: string): string | null {
  if (!_client) return null;
  try {
    // Langfuse v3 constructs trace URLs from the base URL + trace ID
    const base = (process.env['LANGFUSE_HOST'] as string) || 'https://cloud.langfuse.com';
    return `${base}/trace/${traceId}`;
  } catch {
    return null;
  }
}

// ─── Trace: Agent Task ──────────────────────────────────────────────────────

/**
 * Start an agent task trace.
 * Called at the beginning of each agent task execution.
 */
export function startAgentTaskTrace(
  taskQuery: string,
  metadata?: Record<string, unknown>,
): { traceId: string; agentName: string; startTime: number } | null {
  if (!isTracing() || !_client) return null;

  try {
    const taskName = typeof taskQuery === 'string'
      ? taskQuery.slice(0, 80).replace(/\n/g, ' ')
      : 'agent-task';

    _currentTrace = _client.trace({
      name: taskName,
      input: { query: taskQuery.slice(0, 500) },
      metadata: {
        agent: 'genericagent-js',
        timestamp: new Date().toISOString(),
        ...metadata,
      },
    });

    return {
      traceId: _currentTrace.id,
      agentName: taskName,
      startTime: Date.now(),
    };
  } catch (err) {
    console.error(`[Langfuse] Failed to start trace: ${err}`);
    return null;
  }
}

/**
 * End the current agent task trace.
 */
export function endAgentTaskTrace(
  result?: string,
  metadata?: Record<string, unknown>,
): void {
  if (!_currentTrace) return;

  try {
    _currentTrace.update({
      output: result ? { summary: result.slice(0, 500) } : undefined,
      metadata: metadata ? { ...metadata } : undefined,
    });
    _currentTrace = null;
  } catch (err) {
    console.error(`[Langfuse] Failed to end trace: ${err}`);
  }
}

// ─── Span: LLM Generation ───────────────────────────────────────────────────

/**
 * Start tracing an LLM generation call.
 * Created as a "generation" observation under the current agent trace.
 */
export function startLLMGeneration(
  model: string,
  messages: unknown[],
  modelParameters?: Record<string, unknown>,
): any | null {
  if (!_currentTrace) return null;

  try {
    // Summarize messages for input logging
    const msgSummary = Array.isArray(messages)
      ? messages.slice(0, 5).map((m: any) => ({
          role: m?.role || 'unknown',
          contentLen: typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content || '').length,
        }))
      : '(non-array input)';

    _currentGeneration = _currentTrace.generation({
      name: `llm-${model.slice(0, 40)}`,
      model,
      modelParameters: modelParameters || {},
      input: msgSummary,
    });

    return _currentGeneration;
  } catch (err) {
    console.error(`[Langfuse] Failed to start generation: ${err}`);
    return null;
  }
}

/**
 * End the current LLM generation with usage and output.
 */
export function endLLMGeneration(
  output?: string,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
  error?: string,
): void {
  const gen = _currentGeneration;
  _currentGeneration = null;

  if (!gen) return;

  try {
    const endPayload: any = {};

    if (error) {
      endPayload.level = 'ERROR';
      endPayload.statusMessage = error;
    }

    if (output) {
      endPayload.output = { response: output.slice(0, 2000) };
    }

    if (usage) {
      endPayload.usage = {
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      };
    }

    gen.end(endPayload);
  } catch (err) {
    console.error(`[Langfuse] Failed to end generation: ${err}`);
  }
}

// ─── Span: Tool Call ────────────────────────────────────────────────────────

/**
 * Start tracing a tool call as a span under the current generation.
 */
export function startToolCall(
  toolName: string,
  args: Record<string, unknown>,
): any | null {
  if (!_currentTrace) return null;

  try {
    const tool = _currentTrace.span({
      name: `tool-${toolName}`,
      input: sanitizeArgs(args),
      metadata: {
        toolName,
      },
    });

    return tool;
  } catch (err) {
    console.error(`[Langfuse] Failed to start tool span: ${err}`);
    return null;
  }
}

/**
 * End a tool call span with the result.
 */
export function endToolCall(
  span: any | null,
  output?: string,
  error?: string,
): void {
  if (!span) return;

  try {
    const endPayload: any = {};

    if (output) {
      endPayload.output = { result: output.slice(0, 1000) };
    }

    if (error) {
      endPayload.level = 'ERROR';
      endPayload.statusMessage = error;
    }

    span.end(endPayload);
  } catch (err) {
    console.error(`[Langfuse] Failed to end tool span: ${err}`);
  }
}

// ─── Helper: sanitize args for safe tracing ──────────────────────────────────

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('_')) continue; // skip internal fields
    if (typeof value === 'string') {
      safe[key] = value.length > 500 ? value.slice(0, 500) + '...' : value;
    } else if (typeof value === 'object' && value !== null) {
      safe[key] = '[object]';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

// ─── Convenience: traceGeneration (backward-compat) ──────────────────────────

/**
 * Trace a single generation (backward-compat with placeholder API).
 */
export function traceGeneration(
  name: string,
  input: unknown,
  output: unknown,
): void {
  if (!isTracing() || !_client) return;

  try {
    const trace = _client.trace({ name });
    trace.generation({
      name,
      input: typeof input === 'string' ? input.slice(0, 1000) : input,
      output: typeof output === 'string' ? output.slice(0, 1000) : output,
    });
  } catch { /* ignore tracing errors */ }
}
