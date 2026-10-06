// Host-page SDK: start a proctoring session and receive events.
// Runs on the integrator's exam page. No runtime dependencies (only zod-free constants from core).
import {
  PROCTOR_EVENT_SOURCE,
  SDK_EVENTS,
  type ExternalErrorCode,
  type ExternalRequest,
  type ExternalResponse,
  type SdkEventMessage,
  type SdkEventName,
} from '@proctor/core';

export type { SdkEventName };

export type ProctorErrorCode =
  ExternalErrorCode | 'extension_not_installed' | 'invalid_options' | 'unexpected_response';

export class ProctorError extends Error {
  readonly code: ProctorErrorCode;
  constructor(code: ProctorErrorCode, message: string = code) {
    super(message);
    this.name = 'ProctorError';
    this.code = code;
  }
}

export interface ProctorStartOptions {
  /** Short-lived session token issued by the backend for this candidate session. */
  sessionToken: string;
  /** Backend base URL, e.g. https://proctor-api.example.com. Must be allow-listed in the extension. */
  apiBase: string;
  /** ID of the installed proctoring extension. */
  extensionId: string;
}

/** Browser bindings, injectable for tests. */
export interface ProctorEnvironment {
  sendMessage(extensionId: string, message: ExternalRequest): Promise<unknown>;
  /** Where relayed window messages arrive (the page's window). */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** True when the message came from this window (the extension's content script relay). */
  isOwnWindow(event: MessageEvent): boolean;
}

type ChromeLike = { runtime?: { sendMessage?: (id: string, msg: unknown) => Promise<unknown> } };

export function browserEnvironment(): ProctorEnvironment {
  const runtime = (globalThis as { chrome?: ChromeLike }).chrome?.runtime;
  const send = runtime?.sendMessage;
  if (!send) throw new ProctorError('extension_not_installed');
  return {
    sendMessage: (id, msg) => send.call(runtime, id, msg),
    target: window,
    isOwnWindow: (event) => event.source === window,
  };
}

function isResponse(value: unknown): value is ExternalResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.ok === true || (v.ok === false && typeof v.error === 'string');
}

function isSdkEvent(value: unknown): value is SdkEventMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.source === PROCTOR_EVENT_SOURCE &&
    typeof v.sessionId === 'string' &&
    (SDK_EVENTS as readonly unknown[]).includes(v.event)
  );
}

async function request(
  env: ProctorEnvironment,
  extensionId: string,
  message: ExternalRequest,
): Promise<ExternalResponse & { ok: true }> {
  let response: unknown;
  try {
    response = await env.sendMessage(extensionId, message);
  } catch {
    // Chrome rejects with "Could not establish connection" when the extension is absent.
    throw new ProctorError('extension_not_installed');
  }
  if (!isResponse(response)) throw new ProctorError('unexpected_response');
  if (!response.ok) throw new ProctorError(response.error);
  return response;
}

type Listener = () => void;

export class ProctorSession {
  private id: string | undefined;
  private readonly listeners = new Map<SdkEventName, Set<Listener>>();
  private readonly pending: SdkEventMessage[] = [];
  private readonly onMessage = (raw: Event) => {
    const event = raw as MessageEvent;
    if (!this.env.isOwnWindow(event) || !isSdkEvent(event.data)) return;
    if (this.id === undefined) this.pending.push(event.data);
    else this.deliver(event.data);
  };

  /** @internal Use Proctor.start(). */
  constructor(
    private readonly env: ProctorEnvironment,
    private readonly extensionId: string,
  ) {
    env.target.addEventListener('message', this.onMessage);
  }

  get sessionId(): string | undefined {
    return this.id;
  }

  /** Subscribes to an event. Returns an unsubscribe function. */
  on(event: SdkEventName, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Ends the session: the extension turns the camera and microphone off. */
  async end(): Promise<void> {
    await request(this.env, this.extensionId, { type: 'proctor:end' });
  }

  /** Stops listening for events. Called automatically after `ended` or `consent_declined`. */
  dispose(): void {
    this.env.target.removeEventListener('message', this.onMessage);
  }

  /** @internal */
  bind(sessionId: string): void {
    this.id = sessionId;
    // Flush on the next task, after the caller's `await Proctor.start()` continuation has had
    // a chance to register listeners.
    setTimeout(() => {
      for (const message of this.pending.splice(0)) this.deliver(message);
    }, 0);
  }

  private deliver(message: SdkEventMessage): void {
    if (message.sessionId !== this.id) return;
    for (const listener of this.listeners.get(message.event) ?? []) listener();
    if (message.event === 'ended' || message.event === 'consent_declined') this.dispose();
  }
}

export const Proctor = {
  /**
   * Asks the extension to start a session. Resolves once the extension has accepted the request
   * and shown the consent notice; listen for `ready` (capture running), `consent_declined` or
   * `ended`. The proctoring result is advisory and never affects the exam itself.
   */
  async start(
    options: ProctorStartOptions,
    env: ProctorEnvironment = browserEnvironment(),
  ): Promise<ProctorSession> {
    const { sessionToken, apiBase, extensionId } = options;
    if (![sessionToken, apiBase, extensionId].every((v) => typeof v === 'string' && v !== '')) {
      throw new ProctorError('invalid_options');
    }
    // Listen before sending so no event can be missed.
    const session = new ProctorSession(env, extensionId);
    try {
      const response = await request(env, extensionId, {
        type: 'proctor:start',
        sessionToken,
        apiBase,
      });
      if (typeof response.sessionId !== 'string') throw new ProctorError('unexpected_response');
      session.bind(response.sessionId);
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  },
};
