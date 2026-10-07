import { RawBrowserEventSchema, type RawBrowserEvent } from '@proctor/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserMonitor, isRefreshShortcut, type MonitorDocument } from './monitor';

class FakeDocument extends EventTarget implements MonitorDocument {
  hidden = false;
  fullscreenElement: unknown = null;
  focused = true;
  hasFocus(): boolean {
    return this.focused;
  }
}

/** A DOM-like event carrying whatever extra (sensitive) properties a real event would. */
function domEvent(type: string, props: Record<string, unknown> = {}): Event {
  const event = new Event(type);
  // defineProperty (not assign) so getters such as Event.target can be shadowed.
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, enumerable: true });
  }
  return event;
}

function setup(navigationType = 'navigate') {
  const doc = new FakeDocument();
  const win = new EventTarget();
  const sent: RawBrowserEvent[] = [];
  let clock = 1_000;
  const intervals: (() => void)[] = [];
  const timeouts: (() => void)[] = [];
  const monitor = new BrowserMonitor({
    doc,
    win,
    now: () => clock,
    send: (e) => sent.push(e),
    navigationType: () => navigationType,
    setInterval: (fn) => intervals.push(fn) - 1,
    clearInterval: (id) => {
      intervals[id as number] = () => undefined;
    },
    setTimeout: (fn) => timeouts.push(fn),
  });
  return {
    doc,
    win,
    sent,
    monitor,
    advance: (ms: number) => (clock += ms),
    tick: () => {
      for (const fn of intervals) fn();
    },
    flushTimeouts: () => {
      for (const fn of timeouts.splice(0)) fn();
    },
  };
}

describe('isRefreshShortcut', () => {
  it.each([
    [{ key: 'F5' }, true],
    [{ key: 'r', ctrlKey: true }, true],
    [{ key: 'R', ctrlKey: true }, true],
    [{ key: 'r', metaKey: true }, true],
    [{ key: 'r' }, false],
    [{ key: 'a', ctrlKey: true }, false],
    [{}, false],
    [{ key: 42 }, false],
  ])('%j -> %s', (event, expected) => {
    expect(isRefreshShortcut(event)).toBe(expected);
  });
});

describe('BrowserMonitor', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    h.monitor.start({ pingMs: 5000, pageLoad: false });
  });

  it('sends a state snapshot on start', () => {
    expect(h.sent).toEqual([
      { kind: 'fullscreenchange', ts: 1000, isFullscreen: false },
      { kind: 'visibilitychange', ts: 1000, hidden: false },
      { kind: 'focus', ts: 1000 },
    ]);
  });

  it('maps fullscreen, visibility, focus, clipboard and refresh-key events', () => {
    h.sent.length = 0;
    h.doc.fullscreenElement = {};
    h.doc.dispatchEvent(domEvent('fullscreenchange'));
    h.doc.fullscreenElement = null;
    h.doc.dispatchEvent(domEvent('fullscreenchange'));
    h.doc.hidden = true;
    h.doc.dispatchEvent(domEvent('visibilitychange'));
    h.win.dispatchEvent(domEvent('focus'));
    h.doc.dispatchEvent(domEvent('copy'));
    h.doc.dispatchEvent(domEvent('cut'));
    h.doc.dispatchEvent(domEvent('paste'));
    h.win.dispatchEvent(domEvent('keydown', { key: 'F5' }));
    expect(h.sent.map((e) => e.kind)).toEqual([
      'fullscreenchange',
      'fullscreenchange',
      'visibilitychange',
      'focus',
      'copy',
      'cut',
      'paste',
      'refresh_key',
      'activity', // keydown also counts as activity
    ]);
    expect(h.sent[0]).toMatchObject({ isFullscreen: true });
    expect(h.sent[1]).toMatchObject({ isFullscreen: false });
    expect(h.sent[2]).toMatchObject({ hidden: true });
  });

  it('reports blur only when focus really left the page (not into an iframe)', () => {
    h.sent.length = 0;
    h.win.dispatchEvent(domEvent('blur')); // focus moved into an iframe: page still has focus
    h.flushTimeouts();
    expect(h.sent).toEqual([]);
    h.doc.focused = false;
    h.win.dispatchEvent(domEvent('blur'));
    h.advance(50);
    h.flushTimeouts();
    expect(h.sent).toEqual([{ kind: 'blur', ts: 1000 }]); // stamped at the event, not the check
  });

  it('throttles activity to one message per ping interval', () => {
    h.sent.length = 0;
    for (const type of ['pointermove', 'pointerdown', 'wheel', 'scroll', 'touchstart']) {
      h.win.dispatchEvent(domEvent(type));
    }
    h.advance(4999);
    h.win.dispatchEvent(domEvent('pointermove'));
    h.advance(1);
    h.win.dispatchEvent(domEvent('pointermove'));
    expect(h.sent).toEqual([
      { kind: 'activity', ts: 1000 },
      { kind: 'activity', ts: 6000 },
    ]);
  });

  it('sends ticks on the ping interval', () => {
    h.sent.length = 0;
    h.advance(5000);
    h.tick();
    expect(h.sent).toEqual([{ kind: 'tick', ts: 6000 }]);
  });

  it('stops listening and ticking on stop', () => {
    h.monitor.stop();
    expect(h.monitor.running).toBe(false);
    h.sent.length = 0;
    h.doc.dispatchEvent(domEvent('copy'));
    h.win.dispatchEvent(domEvent('pointermove'));
    h.tick();
    expect(h.sent).toEqual([]);
  });

  it('restarts cleanly without duplicate listeners', () => {
    h.monitor.start({ pingMs: 5000, pageLoad: false });
    h.sent.length = 0;
    h.doc.dispatchEvent(domEvent('paste'));
    expect(h.sent).toEqual([{ kind: 'paste', ts: 1000 }]);
  });

  it('snapshots a hidden, unfocused, fullscreen page', () => {
    const x = setup();
    x.doc.hidden = true;
    x.doc.focused = false;
    x.doc.fullscreenElement = {};
    x.monitor.start({ pingMs: 1000, pageLoad: false });
    expect(x.sent.map((e) => e.kind)).toEqual(['fullscreenchange', 'visibilitychange', 'blur']);
    expect(x.sent[0]).toMatchObject({ isFullscreen: true });
  });
});

describe('BrowserMonitor refresh detection', () => {
  it('reports a completed reload once, when monitoring resumes on page load', () => {
    const h = setup('reload');
    h.monitor.start({ pingMs: 1000, pageLoad: true });
    h.monitor.start({ pingMs: 1000, pageLoad: true });
    expect(h.sent.filter((e) => e.kind === 'page_reload')).toHaveLength(1);
  });

  it('ignores a reload that happened before monitoring started', () => {
    const h = setup('reload');
    h.monitor.start({ pingMs: 1000, pageLoad: false });
    expect(h.sent.some((e) => e.kind === 'page_reload')).toBe(false);
  });

  it('ignores ordinary navigations', () => {
    const h = setup('navigate');
    h.monitor.start({ pingMs: 1000, pageLoad: true });
    expect(h.sent.some((e) => e.kind === 'page_reload')).toBe(false);
  });
});

describe('BrowserMonitor privacy', () => {
  it('sends only kind + timestamp, never keys, text, clipboard data or URLs', () => {
    const h = setup('reload');
    h.monitor.start({ pingMs: 1, pageLoad: true });
    const secret = {
      key: 'S',
      code: 'KeyS',
      clipboardData: { getData: () => 'SECRET-ANSWER' },
      target: { value: 'typed SECRET-ANSWER', textContent: 'question text' },
      url: 'https://exam.example/q/42?token=abc',
    };
    for (const type of ['keydown', 'copy', 'cut', 'paste', 'pointermove', 'visibilitychange']) {
      h.advance(10);
      (type === 'keydown' || type === 'pointermove' ? h.win : h.doc).dispatchEvent(
        domEvent(type, secret),
      );
    }
    h.win.dispatchEvent(domEvent('keydown', { ...secret, key: 'r', ctrlKey: true }));

    const allowed = new Set(['kind', 'ts', 'hidden', 'isFullscreen']);
    for (const event of h.sent) {
      for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
      expect(() => RawBrowserEventSchema.parse(event)).not.toThrow();
    }
    const json = JSON.stringify(h.sent);
    for (const leak of ['SECRET-ANSWER', 'question text', 'KeyS', '"S"', 'exam.example', 'token']) {
      expect(json).not.toContain(leak);
    }
    expect(h.sent.some((e) => e.kind === 'refresh_key')).toBe(true);
  });
});
