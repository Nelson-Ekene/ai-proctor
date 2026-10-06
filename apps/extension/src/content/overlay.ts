// Visible in-page indicator shown while the camera and microphone are on (FR11).

export const INDICATOR_HOST_ID = 'proctor-recording-indicator';

const STYLE = `
:host { all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; pointer-events: none; }
.pill { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px;
  background: rgba(17, 24, 39, 0.92); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
`;

export const INDICATOR_TEXT = 'Camera and microphone on · proctoring active';

export class RecordingIndicator {
  private host: HTMLElement | undefined;
  private observer: MutationObserver | undefined;

  constructor(private readonly doc: Document) {}

  get visible(): boolean {
    return this.host?.isConnected === true;
  }

  show(): void {
    if (this.visible) return;
    const host = this.doc.createElement('div');
    host.id = INDICATOR_HOST_ID;
    const root = host.attachShadow({ mode: 'open' });
    const style = this.doc.createElement('style');
    style.textContent = STYLE;
    const pill = this.doc.createElement('div');
    pill.className = 'pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    const dot = this.doc.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = this.doc.createElement('span');
    text.textContent = INDICATOR_TEXT;
    pill.append(dot, text);
    root.append(style, pill);
    this.host = host;
    this.doc.documentElement.append(host);

    // Keep the indicator visible even if the page removes it.
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => {
      if (this.host && !this.host.isConnected) this.doc.documentElement.append(this.host);
    });
    this.observer.observe(this.doc.documentElement, { childList: true });
  }

  hide(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.host?.remove();
    this.host = undefined;
  }
}
