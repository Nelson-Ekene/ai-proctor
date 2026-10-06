import { describe, expect, it, vi } from 'vitest';
import { Proctor, ProctorError, browserEnvironment, type ProctorEnvironment } from './index';

const OPTIONS = { sessionToken: 'tok', apiBase: 'https://api.example', extensionId: 'ext' };

function fakeEnv(respond: (msg: unknown) => unknown = () => ({ ok: true, sessionId: 's1' })) {
  const target = new EventTarget();
  let own = true;
  const sendMessage = vi.fn((_id: string, msg: unknown) => Promise.resolve(respond(msg)));
  const env: ProctorEnvironment = { sendMessage, target, isOwnWindow: () => own };
  const emit = (data: unknown) => target.dispatchEvent(new MessageEvent('message', { data }));
  const event = (name: string, sessionId = 's1') =>
    emit({ source: 'proctor-extension', event: name, sessionId });
  return {
    env,
    sendMessage,
    emit,
    event,
    setOwn: (v: boolean) => {
      own = v;
    },
  };
}

async function rejectionCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProctorError) return e.code;
    throw e;
  }
  throw new Error('expected rejection');
}

describe('Proctor.start', () => {
  it('sends a start request to the extension and returns a bound session', async () => {
    const f = fakeEnv();
    const session = await Proctor.start(OPTIONS, f.env);
    expect(f.sendMessage).toHaveBeenCalledWith('ext', {
      type: 'proctor:start',
      sessionToken: 'tok',
      apiBase: 'https://api.example',
    });
    expect(session.sessionId).toBe('s1');
  });

  it('validates options', async () => {
    const f = fakeEnv();
    expect(await rejectionCode(Proctor.start({ ...OPTIONS, sessionToken: '' }, f.env))).toBe(
      'invalid_options',
    );
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('maps extension errors and missing extension', async () => {
    expect(
      await rejectionCode(
        Proctor.start(OPTIONS, fakeEnv(() => ({ ok: false, error: 'api_not_allowed' })).env),
      ),
    ).toBe('api_not_allowed');

    const absent = fakeEnv();
    absent.sendMessage.mockImplementation(() => Promise.reject(new Error('no connection')));
    expect(await rejectionCode(Proctor.start(OPTIONS, absent.env))).toBe('extension_not_installed');
  });

  it.each([undefined, 'nope', { ok: 'yes' }, { ok: false }, { ok: true }])(
    'rejects an unexpected response %j',
    async (response) => {
      expect(await rejectionCode(Proctor.start(OPTIONS, fakeEnv(() => response).env))).toBe(
        'unexpected_response',
      );
    },
  );

  it('stops listening when start fails', async () => {
    const f = fakeEnv(() => ({ ok: false, error: 'session_in_progress' }));
    const remove = vi.spyOn(f.env.target, 'removeEventListener');
    await rejectionCode(Proctor.start(OPTIONS, f.env));
    expect(remove).toHaveBeenCalled();
  });
});

describe('ProctorSession events', () => {
  it('delivers ready, then ended, and stops listening after ended', async () => {
    const f = fakeEnv();
    const session = await Proctor.start(OPTIONS, f.env);
    const seen: string[] = [];
    session.on('ready', () => seen.push('ready'));
    session.on('ended', () => seen.push('ended'));
    f.event('ready');
    f.event('ended');
    f.event('ready'); // after dispose: ignored
    expect(seen).toEqual(['ready', 'ended']);
  });

  it('delivers consent_declined and disposes', async () => {
    const f = fakeEnv();
    const session = await Proctor.start(OPTIONS, f.env);
    const declined = vi.fn();
    session.on('consent_declined', declined);
    f.event('consent_declined');
    f.event('consent_declined');
    expect(declined).toHaveBeenCalledTimes(1);
  });

  it('buffers events that arrive before the start response', async () => {
    const f = fakeEnv();
    f.sendMessage.mockImplementation(() => {
      f.event('ready');
      return Promise.resolve({ ok: true, sessionId: 's1' });
    });
    const session = await Proctor.start(OPTIONS, f.env);
    const ready = vi.fn();
    session.on('ready', ready); // registered right after the await, as integrators will
    expect(ready).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('ignores other sessions, foreign windows, and malformed messages', async () => {
    const f = fakeEnv();
    const session = await Proctor.start(OPTIONS, f.env);
    const ready = vi.fn();
    session.on('ready', ready);
    f.event('ready', 'other-session');
    f.emit({ source: 'someone-else', event: 'ready', sessionId: 's1' });
    f.emit({ source: 'proctor-extension', event: 'disqualified', sessionId: 's1' });
    f.emit('ready');
    f.emit(null);
    f.setOwn(false);
    f.event('ready');
    expect(ready).not.toHaveBeenCalled();
  });

  it('unsubscribes', async () => {
    const f = fakeEnv();
    const session = await Proctor.start(OPTIONS, f.env);
    const ready = vi.fn();
    const off = session.on('ready', ready);
    session.on('ready', () => undefined);
    off();
    f.event('ready');
    expect(ready).not.toHaveBeenCalled();
  });

  it('end() asks the extension to end the session', async () => {
    const f = fakeEnv();
    const session = await Proctor.start(OPTIONS, f.env);
    await session.end();
    expect(f.sendMessage).toHaveBeenLastCalledWith('ext', { type: 'proctor:end' });
  });

  it('end() surfaces extension errors', async () => {
    const f = fakeEnv((msg) =>
      (msg as { type: string }).type === 'proctor:end'
        ? { ok: false, error: 'no_session' }
        : { ok: true, sessionId: 's1' },
    );
    const session = await Proctor.start(OPTIONS, f.env);
    expect(await rejectionCode(session.end())).toBe('no_session');
  });
});

describe('browserEnvironment', () => {
  it('reports a missing extension when chrome.runtime is unavailable', () => {
    expect(() => browserEnvironment()).toThrow(ProctorError);
  });

  it('binds to chrome.runtime.sendMessage and window when present', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ ok: true }));
    const win = new EventTarget();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    vi.stubGlobal('window', win);
    try {
      const env = browserEnvironment();
      await env.sendMessage('ext', { type: 'proctor:status' });
      expect(sendMessage).toHaveBeenCalledWith('ext', { type: 'proctor:status' });
      expect(env.target).toBe(win);
      expect(env.isOwnWindow(new MessageEvent('message', { data: 1 }))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
