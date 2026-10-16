// The demo exam page. Plain HTML + the proctoring SDK, like an integrator's exam site.
// Contains a "secret" answer: tests assert it never leaves the device in any upload.

export const SECRET_TEXT = 'SECRET-ANSWER-42';

export function page({ dashboardUrl }: { dashboardUrl: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo exam</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
    section { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
    button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #94a3b8; background: #fff; cursor: pointer; }
    button.primary { background: #0f172a; color: #fff; border-color: #0f172a; }
    button:disabled { opacity: .5; cursor: default; }
    input, textarea { font: inherit; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; }
    textarea { width: 100%; box-sizing: border-box; }
    #status { font-weight: 600; }
    .muted { color: #475569; font-size: 14px; }
    ol li { margin: 4px 0; }
  </style>
</head>
<body>
<main>
  <h1>Demo exam</h1>
  <p class="muted">A pretend exam site for trying the Hawkeye extension end to end. Proctoring
  here is advisory: it flags moments for a human reviewer and never decides a result.</p>

  <section id="start-section">
    <h2>1. Start</h2>
    <label>Candidate reference <input id="candidate" value="demo-candidate" autocomplete="off"></label>
    <button id="start" class="primary">Start exam</button>
    <p>Status: <span id="status">not started</span></p>
    <ul id="events" class="muted"></ul>
  </section>

  <section id="exam" hidden>
    <h2>2. Exam</h2>
    <p id="question">Question 1: What is 6 × 7? (Page text such as ${SECRET_TEXT} must never be uploaded.)</p>
    <textarea id="answer" rows="3">${SECRET_TEXT}</textarea>
    <h3>Try the browser checks</h3>
    <ol class="muted">
      <li><button id="fs-enter">Enter fullscreen</button> then press Esc (left fullscreen).</li>
      <li>Switch to another tab or window, then come back (switched tab or window).</li>
      <li>Select the text above and press Ctrl+C, then Ctrl+V in the box (copy or paste).</li>
      <li>Press F5 to refresh (page refresh; the session continues).</li>
      <li>Hold up a phone, leave the camera, or talk (video and audio checks).</li>
    </ol>
    <button id="end" class="primary">Finish exam</button>
  </section>

  <section>
    <h2>3. Review</h2>
    <p class="muted">After finishing, open the <a href="${dashboardUrl}" target="_blank" rel="noopener">reviewer dashboard</a>
    and sign in to see the session, its score and the evidence for each flagged moment.</p>
  </section>
</main>
<script type="module">
  import { Proctor } from '/proctor-sdk.js';
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $('status').textContent = text; };
  const log = (text) => { const li = document.createElement('li'); li.textContent = text; $('events').append(li); };
  let session;

  // A refresh keeps the session: remember it for this tab only.
  const saved = sessionStorage.getItem('demo.session');
  if (saved) { $('exam').hidden = false; status('in progress (page refreshed)'); }

  $('start').addEventListener('click', async () => {
    $('start').disabled = true;
    status('starting…');
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidateRef: $('candidate').value }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'could not start');
      const started = await res.json();
      // ?ext= overrides the extension ID (store or test builds have a different one).
      const extensionId = new URLSearchParams(location.search).get('ext') ?? started.extensionId;
      const { sessionToken, apiBase } = started;
      status('waiting for consent in the new tab…');
      session = await Proctor.start({ sessionToken, apiBase, extensionId });
      sessionStorage.setItem('demo.session', session.sessionId);
      sessionStorage.setItem('demo.extension', extensionId);
      log('started: ' + session.sessionId);
      session.on('ready', () => { status('proctoring active'); log('ready'); $('exam').hidden = false; });
      session.on('consent_declined', () => { status('consent declined (nothing is recorded)'); log('consent_declined'); });
      session.on('ended', () => { status('ended'); log('ended'); sessionStorage.removeItem('demo.session'); });
    } catch (e) {
      status('could not start: ' + (e.code ?? e.message) + ' (is the extension installed?)');
      log('error: ' + (e.code ?? e.message));
      $('start').disabled = false;
    }
  });

  $('end').addEventListener('click', async () => {
    try {
      if (session) await session.end();
      else {
        // After a refresh the SDK object is gone: ask the extension directly (same message).
        const extensionId = sessionStorage.getItem('demo.extension');
        if (extensionId) await chrome.runtime.sendMessage(extensionId, { type: 'proctor:end' });
      }
    } catch (e) { log('error: ' + (e.code ?? e.message)); }
    status('ended');
    sessionStorage.removeItem('demo.session');
    $('end').disabled = true;
  });

  $('fs-enter').addEventListener('click', () => { void document.documentElement.requestFullscreen(); });
</script>
</body>
</html>`;
}
