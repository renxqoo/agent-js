import { WebSocketServer, WebSocket } from 'ws';
import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as net from 'net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Session record stored for each connected browser tab / extension. */
export interface SessionData {
  /** Unique session identifier (assigned by the extension or generated here). */
  id: string;
  /** Arbitrary metadata reported by the extension (url, title, …). */
  info: Record<string, unknown>;
  /** Timestamp (ms) when the session was first seen. */
  connectAt: number;
  /** Timestamp when the session disconnected, or null if still connected. */
  disconnectAt: number | null;
  /** How the session is attached. */
  type: 'ws' | 'ext_ws' | 'http';
  /** The live WebSocket client, if this is a WS-connected session. */
  wsClient: WebSocket | null;
  /** Pending HTTP requests (exec IDs) waiting for results. */
  httpQueue: string[];
}

/** Payload sent via WS or HTTP to request JS execution. */
export interface ExecPayload {
  type: 'execute';
  execId: string;
  code: string;
  sessionId?: string;
}

/** Any message received over the WebSocket. */
export interface WSMessage {
  type: string;
  // ready / ext_ready
  sessionId?: string;
  info?: Record<string, unknown>;
  // tabs_update
  sessions?: SessionData[];
  // ack
  execId?: string;
  // result
  result?: unknown;
  // error
  error?: string;
}

/** Shape of entries in the results dictionary. */
interface ResultEntry {
  execId: string;
  result: unknown;
  error: string | null;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18765;
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 28_000; // just under 30 s for long-poll

// ---------------------------------------------------------------------------
// TMWebDriver
// ---------------------------------------------------------------------------

/**
 * WebSocket + HTTP bridge for Chrome DevTools Protocol.
 *
 * The server relays messages between browser extensions (which connect via
 * the assets/tmwd_cdp_bridge/ helpers) and external callers that want to
 * execute JavaScript in browser tabs.
 *
 * Modes
 * -----
 * - **Local**: starts its own WS + HTTP servers on `host:port`.
 * - **Remote**: assumes servers are already running elsewhere and connects
 *   to them via HTTP (the remote endpoint must accept the same API).
 */
export class TMWebDriver {
  readonly host: string;
  readonly port: number;
  readonly remote: boolean;

  // ---- server handles (only in local mode) ----
  private httpServer: ReturnType<typeof express> | null = null;
  private httpListener: any = null;
  private wss: WebSocketServer | null = null;

  // ---- state ----
  readonly sessions: Map<string, SessionData> = new Map();
  readonly results: Map<string, ResultEntry> = new Map();
  readonly acks: Map<string, boolean> = new Map();

  // Long-poll subscribers waiting for a specific execId.
  private pollSubscribers: Map<
    string,
    Array<{ res: Response; timer: NodeJS.Timeout }>
  > = new Map();

  // ------------------------------------------------------------------
  constructor(host: string = DEFAULT_HOST, port: number = DEFAULT_PORT) {
    this.host = host;
    this.port = port;

    // Remote-mode detection: try a quick TCP connect to otherPort (port+1).
    // If it succeeds we assume servers are already up and we act as a proxy.
    this.remote = this._checkRemote(host, port + 1);

    if (!this.remote) {
      this._startHttpServer();
      this._startWsServer();
    }
  }

  // ------------------------------------------------------------------
  // Remote-mode detection
  // ------------------------------------------------------------------

  private _checkRemote(host: string, otherPort: number): boolean {
    try {
      const sock = new net.Socket();
      let resolved = false;

      sock.setTimeout(500);
      sock.on('connect', () => {
        resolved = true;
        sock.destroy();
      });
      sock.on('error', () => {
        resolved = true;
        sock.destroy();
      });
      sock.on('timeout', () => {
        resolved = true;
        sock.destroy();
      });

      sock.connect(otherPort, host);

      // Block until resolved (synchronous busy-wait – acceptable during
      // construction since it is a one-shot sub-second check).
      const start = Date.now();
      while (!resolved && Date.now() - start < 600) {
        // no-op; the event-loop gets to run in between iterations thanks to
        // the Node.js microtask queue, but for a simple constructor check we
        // rely on the socket callbacks to flip `resolved`.
      }

      // After the socket callbacks have had a chance to fire, check again.
      // In practice the socket is either connected or errored by now.
      return !sock.destroyed && !sock.connecting;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // HTTP server (Express)
  // ------------------------------------------------------------------

  private _startHttpServer(): void {
    const app = express();
    app.use(express.json({ limit: '5mb' }));

    // ---- long-poll endpoint ----
    app.get('/api/longpoll', (req: Request, res: Response) => {
      const execId = req.query.execId as string | undefined;
      this._handleLongPoll(req, res, execId);
    });

    // ---- immediate result lookup ----
    app.get('/api/result', (req: Request, res: Response) => {
      const execId = req.query.execId as string | undefined;
      if (!execId) {
        res.status(400).json({ error: 'missing execId' });
        return;
      }
      const entry = this.results.get(execId);
      if (entry) {
        this.results.delete(execId);
        res.json({ result: entry.result, error: entry.error });
      } else {
        res.json({ result: null, error: 'not found' });
      }
    });

    // ---- main /link endpoint ----
    app.get('/link', (req: Request, res: Response) => {
      this._handleLink(req, res);
    });

    app.post('/link', (req: Request, res: Response) => {
      this._handleLink(req, res);
    });

    // ---- health ----
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', sessions: this.sessions.size });
    });

    this.httpServer = app;

    import('http').then(({ createServer }) => {
      this.httpListener = createServer(app);
      this.httpListener.listen(this.port, this.host, () => {
        // eslint-disable-next-line no-console
        console.log(
          `[TMWebDriver] HTTP server listening on http://${this.host}:${this.port}`
        );
      });
    });
  }

  // ---- /link request handler ----

  private _handleLink(req: Request, res: Response): void {
    const action = (req.query.action as string) || 'execute_js';
    const bodyParams = typeof req.body === 'object' && req.body !== null ? req.body : {};

    try {
      switch (action) {
        case 'get_all_sessions': {
          const all = this._getAllSessions();
          res.json({ sessions: all });
          break;
        }
        case 'find_session': {
          const urlPattern =
            (req.query.url_pattern as string) ||
            (bodyParams.url_pattern as string) ||
            '';
          const session = this._findSession(urlPattern);
          res.json({ session: session ?? null });
          break;
        }
        case 'execute_js': {
          const code =
            (req.query.code as string) || (bodyParams.code as string) || '';
          const timeoutStr =
            (req.query.timeout as string) || (bodyParams.timeout as string);
          const timeout = timeoutStr ? parseInt(timeoutStr, 10) : undefined;
          const sessionId =
            (req.query.session_id as string) ||
            (bodyParams.session_id as string) ||
            undefined;

          // For long-poll capable callers, return immediately with execId.
          const isLongPoll =
            req.query.poll === '1' || req.headers['x-longpoll'] === '1';

          if (isLongPoll) {
            const execId = randomUUID();
            this.executeJs(code, timeout, sessionId, execId).then(result => {
              this.results.set(execId, {
                execId,
                result: result.result,
                error: result.error,
                timestamp: Date.now(),
              });
            });
            res.json({ execId });
          } else {
            this.executeJs(code, timeout, sessionId)
              .then(result => res.json(result))
              .catch(err => res.status(500).json({ error: String(err) }));
          }
          break;
        }
        default:
          res.status(400).json({ error: `unknown action: ${action}` });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }

  private _handleLongPoll(req: Request, res: Response, execId?: string): void {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');

    if (!execId) {
      res.status(400).json({ error: 'missing execId' });
      return;
    }

    // Check if result already available.
    const entry = this.results.get(execId);
    if (entry) {
      this.results.delete(execId);
      res.json({ result: entry.result, error: entry.error });
      return;
    }

    // Subscribe and wait.
    const timer = setTimeout(() => {
      this._unsubscribePoll(execId, res);
      res.json({ result: null, error: 'timeout' });
    }, POLL_TIMEOUT_MS);

    let subs = this.pollSubscribers.get(execId);
    if (!subs) {
      subs = [];
      this.pollSubscribers.set(execId, subs);
    }
    subs.push({ res, timer });

    // Clean up on client disconnect.
    req.on('close', () => {
      clearTimeout(timer);
      this._unsubscribePoll(execId, res);
    });
  }

  private _unsubscribePoll(execId: string, res: Response): void {
    const subs = this.pollSubscribers.get(execId);
    if (!subs) return;
    const idx = subs.findIndex(s => s.res === res);
    if (idx !== -1) subs.splice(idx, 1);
    if (subs.length === 0) this.pollSubscribers.delete(execId);
  }

  private _notifyPollSubscribers(execId: string, entry: ResultEntry): void {
    const subs = this.pollSubscribers.get(execId);
    if (!subs) return;
    for (const { res, timer } of subs) {
      clearTimeout(timer);
      try {
        res.json({ result: entry.result, error: entry.error });
      } catch {
        // response may already be closed
      }
    }
    this.pollSubscribers.delete(execId);
  }

  // ------------------------------------------------------------------
  // WebSocket server
  // ------------------------------------------------------------------

  private _startWsServer(): void {
    this.wss = new WebSocketServer({ port: this.port + 1, host: this.host });
    // eslint-disable-next-line no-console
    console.log(
      `[TMWebDriver] WS server listening on ws://${this.host}:${this.port + 1}`
    );

    this.wss.on('connection', (ws: WebSocket) => {
      let sessionId: string | null = null;
      let sessionType: SessionData['type'] = 'ws';

      ws.on('message', (raw: Buffer | string) => {
        let msg: WSMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // ignore unparseable messages
        }

        switch (msg.type) {
          // ---- browser extension announces itself ----
          case 'ready':
          case 'ext_ready': {
            sessionId = msg.sessionId ?? randomUUID();
            sessionType = msg.type === 'ext_ready' ? 'ext_ws' : 'ws';

            const info = msg.info ?? {};

            const existing = this.sessions.get(sessionId);
            if (existing) {
              existing.wsClient = ws;
              existing.disconnectAt = null;
              existing.info = { ...existing.info, ...info };
            } else {
              this.sessions.set(sessionId, {
                id: sessionId,
                info,
                connectAt: Date.now(),
                disconnectAt: null,
                type: sessionType,
                wsClient: ws,
                httpQueue: [],
              });
            }
            break;
          }

          // ---- list of all tabs from the extension ----
          case 'tabs_update': {
            const incomingSessions: SessionData[] = (msg as any).sessions ?? [];
            for (const s of incomingSessions) {
              const existing = this.sessions.get(s.id);
              if (existing) {
                existing.info = { ...existing.info, ...s.info };
                existing.disconnectAt = null;
              } else {
                this.sessions.set(s.id, {
                  id: s.id,
                  info: s.info ?? {},
                  connectAt: Date.now(),
                  disconnectAt: null,
                  type: s.type ?? 'ext_ws',
                  wsClient: ws,
                  httpQueue: [],
                });
              }
            }
            break;
          }

          // ---- execution acknowledged by the extension ----
          case 'ack': {
            const execId = msg.execId;
            if (execId) {
              this.acks.set(execId, true);
            }
            break;
          }

          // ---- result arrived from the extension ----
          case 'result': {
            const execId = msg.execId;
            const result = msg.result ?? null;
            const error = msg.error ?? null;

            if (execId) {
              const entry: ResultEntry = {
                execId,
                result,
                error,
                timestamp: Date.now(),
              };
              this.results.set(execId, entry);
              this.acks.set(execId, true);
              this._notifyPollSubscribers(execId, entry);
            }
            break;
          }

          // ---- error reported by the extension ----
          case 'error': {
            const execId = msg.execId;
            const error = msg.error ?? 'unknown error';
            if (execId) {
              const entry: ResultEntry = {
                execId,
                result: null,
                error,
                timestamp: Date.now(),
              };
              this.results.set(execId, entry);
              this.acks.set(execId, true);
              this._notifyPollSubscribers(execId, entry);
            }
            break;
          }

          default:
            // Unknown message type – silently ignored.
            break;
        }
      });

      ws.on('close', () => {
        // Mark the session as disconnected.
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.disconnectAt = Date.now();
            session.wsClient = null;
          }
        }
      });

      ws.on('error', (/* err */) => {
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.disconnectAt = Date.now();
            session.wsClient = null;
          }
        }
      });
    });
  }

  // ------------------------------------------------------------------
  // Session helpers
  // ------------------------------------------------------------------

  /** Return a snapshot of all currently-known sessions. */
  getSessions(): SessionData[] {
    return Array.from(this.sessions.values()).map(s => ({ ...s, wsClient: null }));
  }

  /** Return only connected (non-disconnected) sessions. */
  getActiveSessions(): SessionData[] {
    return this.getSessions().filter(s => s.disconnectAt === null);
  }

  private _getAllSessions(): SessionData[] {
    return this.getActiveSessions();
  }

  /** Find the first active session whose info.url contains `urlPattern`. */
  private _findSession(urlPattern: string): SessionData | null {
    if (!urlPattern) return null;
    const active = this.getActiveSessions();
    for (const s of active) {
      const url = (s.info.url as string) ?? '';
      if (url.includes(urlPattern)) return s;
    }
    return null;
  }

  /**
   * Set the "current" session by URL pattern.
   * This is a convenience wrapper – consumers can also pass `sessionId`
   * directly to `executeJs`.
   */
  private _currentSessionId: string | null = null;

  setSession(urlPattern: string): SessionData | null {
    const session = this._findSession(urlPattern);
    if (session) {
      this._currentSessionId = session.id;
    }
    return session;
  }

  // ------------------------------------------------------------------
  // Navigation shortcuts
  // ------------------------------------------------------------------

  /**
   * Navigate the current (or a specific) session to a URL.
   * Falls back to opening a new tab if no session is available.
   */
  async jump(url: string, timeout: number = 10): Promise<{ result: unknown; error: string | null }> {
    const code = `window.location.href = ${JSON.stringify(url)};`;
    return this.executeJs(code, timeout, this._currentSessionId ?? undefined);
  }

  /**
   * Open a new tab.
   * Returns an execId that can be polled.
   */
  async newtab(url?: string): Promise<{ execId: string }> {
    const execId = randomUUID();
    const code = url
      ? `window.open(${JSON.stringify(url)}, '_blank');`
      : `window.open('', '_blank');`;
    // Fire-and-forget: the extension will pick this up and execute it.
    this.executeJs(code, 15, undefined, execId).catch(() => {
      /* noop – result will be picked up via long-poll */
    });
    return { execId };
  }

  // ------------------------------------------------------------------
  // executeJs – the core method
  // ------------------------------------------------------------------

  /**
   * Execute JavaScript code in a browser tab.
   *
   * @param code      - JavaScript source to evaluate.
   * @param timeout   - Max wait time in seconds (default 15).
   * @param sessionId - Target session; if omitted the first active session
   *                    is used.
   * @param execId    - Execution ID; auto-generated if omitted.
   */
  async executeJs(
    code: string,
    timeout: number = DEFAULT_TIMEOUT_MS / 1000,
    sessionId?: string,
    execId?: string,
  ): Promise<{ result: unknown; error: string | null }> {
    const id = execId ?? randomUUID();
    const timeoutMs = timeout * 1000;

    // Resolve target session.
    let targetSession: SessionData | undefined;
    if (sessionId) {
      targetSession = this.sessions.get(sessionId);
    } else if (this._currentSessionId) {
      targetSession = this.sessions.get(this._currentSessionId);
    }

    if (!targetSession) {
      // Pick the first active session.
      const active = this.getActiveSessions();
      targetSession = active[0];
    }

    if (targetSession && targetSession.wsClient) {
      // ---- send via WebSocket ----
      const payload: ExecPayload = {
        type: 'execute',
        execId: id,
        code,
        sessionId: targetSession.id,
      };

      targetSession.wsClient.send(JSON.stringify(payload));
    } else if (targetSession && targetSession.type === 'http') {
      // HTTP session – queue the execId and wait.
      targetSession.httpQueue.push(id);
    } else {
      // Broadcast via the first connected WS client.
      const active = this.getActiveSessions();
      const firstWsSession = active.find(
        s => s.wsClient && s.wsClient.readyState === WebSocket.OPEN
      );

      if (firstWsSession?.wsClient) {
        const payload: ExecPayload = {
          type: 'execute',
          execId: id,
          code,
          sessionId: firstWsSession.id,
        };
        firstWsSession.wsClient.send(JSON.stringify(payload));
      } else {
        return {
          result: null,
          error: 'No active WebSocket session available for execute_js.',
        };
      }
    }

    // Wait for result with timeout.
    return this._waitForResult(id, timeoutMs);
  }

  private async _waitForResult(
    execId: string,
    timeoutMs: number,
  ): Promise<{ result: unknown; error: string | null }> {
    const start = Date.now();

    return new Promise(resolve => {
      const check = (): void => {
        // Check results map.
        const entry = this.results.get(execId);
        if (entry) {
          this.results.delete(execId);
          this.acks.delete(execId);
          resolve({ result: entry.result, error: entry.error });
          return;
        }

        // Check if acked (still in-flight).
        if (this.acks.get(execId)) {
          if (Date.now() - start >= timeoutMs) {
            this.acks.delete(execId);
            resolve({ result: null, error: 'ack received but result timed out' });
            return;
          }
        } else if (Date.now() - start >= timeoutMs) {
          resolve({ result: null, error: 'timed out waiting for ack' });
          return;
        }

        // Poll again after a short interval.
        setTimeout(check, 50);
      };

      check();
    });
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  /** Shut down both servers gracefully. */
  async close(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpListener) {
      await new Promise<void>(resolve => this.httpListener!.close(() => resolve()));
      this.httpListener = null;
    }
    this.httpServer = null;
    this.sessions.clear();
    this.results.clear();
    this.acks.clear();
    this.pollSubscribers.clear();
  }
}

// Default export for convenience.
export default TMWebDriver;
