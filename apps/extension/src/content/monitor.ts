import type { RawBrowserEvent } from '@proctor/core';

// Browser signal sensor for the exam page (FR5). Turns DOM events into raw rule-engine events
// of kind + timestamp only. It never reads page content, clipboard data, URLs or which key was
// pressed (beyond recognising a refresh shortcut), and it never prevents any default action.

export interface MonitorDocument extends EventTarget {
  readonly hidden: boolean;
  readonly fullscreenElement: unknown;
  hasFocus(): boolean;
}

export interface MonitorEnv {
  doc: MonitorDocument;
  win: EventTarget;
  now(): number;
  send(event: RawBrowserEvent): void;
  /** PerformanceNavigationTiming.type of the current page load ("reload", "navigate", ...). */
  navigationType(): string | undefined;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

/** Events that count as candidate activity (presence only; their content is never read). */
export const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'scroll',
  'touchstart',
] as const;

interface KeyLike {
  key?: unknown;
  ctrlKey?: unknown;
  metaKey?: unknown;
}

/** F5, Ctrl+R / Cmd+R (any shift state). Detection only: the reload is never blocked. */
export function isRefreshShortcut(event: KeyLike): boolean {
  const key = typeof event.key === 'string' ? event.key : '';
  const modifier = event.ctrlKey === true || event.metaKey === true;
  return key === 'F5' || (modifier && key.toLowerCase() === 'r');
}

export interface StartOptions {
  pingMs: number;
  /** True when monitoring resumes as the page loads (e.g. after a refresh). */
  pageLoad: boolean;
}

export class BrowserMonitor {
  private teardown: (() => void)[] = [];
  private lastActivitySent = Number.NEGATIVE_INFINITY;
  private reloadReported = false;

  constructor(private readonly env: MonitorEnv) {}

  get running(): boolean {
    return this.teardown.length > 0;
  }

  start({ pingMs, pageLoad }: StartOptions): void {
    this.stop();
    const { doc, win } = this.env;
    const now = () => this.env.now();
    const send = (event: RawBrowserEvent) => {
      this.env.send(event);
    };

    const on = (target: EventTarget, type: string, handler: (e: Event) => void) => {
      const options = { capture: true, passive: true };
      target.addEventListener(type, handler, options);
      this.teardown.push(() => {
        target.removeEventListener(type, handler, options);
      });
    };

    const activity = () => {
      const ts = now();
      if (ts - this.lastActivitySent < pingMs) return;
      this.lastActivitySent = ts;
      send({ kind: 'activity', ts });
    };

    on(doc, 'fullscreenchange', () => {
      send({ kind: 'fullscreenchange', ts: now(), isFullscreen: doc.fullscreenElement != null });
    });
    on(doc, 'visibilitychange', () => {
      send({ kind: 'visibilitychange', ts: now(), hidden: doc.hidden });
    });
    on(win, 'blur', () => {
      const ts = now();
      // Focus moving into an iframe on the exam page blurs the top window but is not leaving.
      this.env.setTimeout(() => {
        if (!doc.hasFocus()) send({ kind: 'blur', ts });
      }, 0);
    });
    on(win, 'focus', () => {
      send({ kind: 'focus', ts: now() });
    });
    for (const kind of ['copy', 'cut', 'paste'] as const) {
      on(doc, kind, () => {
        send({ kind, ts: now() });
      });
    }
    on(win, 'keydown', (e) => {
      if (isRefreshShortcut(e as KeyLike)) send({ kind: 'refresh_key', ts: now() });
    });
    for (const type of ACTIVITY_EVENTS) on(win, type, activity);

    const tick = this.env.setInterval(() => {
      send({ kind: 'tick', ts: now() });
    }, pingMs);
    this.teardown.push(() => {
      this.env.clearInterval(tick);
    });

    // Snapshot so the engine starts from the page's real state.
    const ts = now();
    send({ kind: 'fullscreenchange', ts, isFullscreen: doc.fullscreenElement != null });
    send({ kind: 'visibilitychange', ts, hidden: doc.hidden });
    send({ kind: doc.hasFocus() ? 'focus' : 'blur', ts });

    // A completed reload while monitoring was active is a refresh attempt. Only checked when
    // monitoring resumes on page load, so a reload before the session started never counts.
    if (pageLoad && !this.reloadReported && this.env.navigationType() === 'reload') {
      this.reloadReported = true;
      send({ kind: 'page_reload', ts });
    }
  }

  stop(): void {
    for (const undo of this.teardown.splice(0)) undo();
  }
}
