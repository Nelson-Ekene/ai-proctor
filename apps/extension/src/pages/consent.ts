import { FACE_MATCH_NOTICE_VERSION, NOTICE_VERSION } from '../messages';
import { el, send } from '../shared/runtime';
import { buildConsentNotice } from './consent-copy';

const app = document.getElementById('app') as HTMLElement;

function inactive(): void {
  app.replaceChildren(
    el('h1', { text: 'This request is no longer active' }),
    el('p', { className: 'muted', text: 'You can close this tab and return to your exam page.' }),
  );
}

async function main(): Promise<void> {
  const response = await send({ type: 'consent:get' });
  if (!response.ok || !response.policy) {
    inactive();
    return;
  }
  const notice = buildConsentNotice(response.policy);

  const checkbox = el('input', { id: 'agree-checkbox' });
  checkbox.type = 'checkbox';
  const agree = el('button', { text: 'I agree', className: 'primary', id: 'agree' });
  agree.disabled = true;
  const decline = el('button', { text: 'I do not agree', id: 'decline' });
  // Shown when accepting fails because the server could not record consent. Nothing starts
  // until it does.
  const retry = el('button', { text: 'Try again', className: 'primary', id: 'retry' });
  const error = el(
    'div',
    { id: 'error' },
    el('p', { className: 'error', text: "Couldn't reach the server, please try again." }),
    retry,
  );
  error.setAttribute('role', 'alert');
  error.hidden = true;
  checkbox.addEventListener('change', () => {
    agree.disabled = !checkbox.checked;
  });

  const label = el(
    'label',
    { className: 'agree' },
    checkbox,
    document.createTextNode(notice.agreeLabel),
  );
  label.htmlFor = checkbox.id;

  // Optional face matching: a separate, unticked choice that never gates "I agree".
  const faceMatchBox = el('input', { id: 'face-match-checkbox' });
  faceMatchBox.type = 'checkbox';
  const faceMatch: HTMLElement[] = [];
  if (notice.faceMatch) {
    const optIn = el(
      'label',
      { className: 'agree' },
      faceMatchBox,
      document.createTextNode(notice.faceMatch.optInLabel),
    );
    optIn.htmlFor = faceMatchBox.id;
    faceMatch.push(
      el('h2', { text: notice.faceMatch.heading }),
      el('ul', {}, ...notice.faceMatch.items.map((item) => el('li', { text: item }))),
      optIn,
    );
  }

  const decide = async (accepted: boolean) => {
    agree.disabled = decline.disabled = retry.disabled = true;
    error.hidden = true;
    const noticeVersion =
      accepted && notice.faceMatch && faceMatchBox.checked
        ? FACE_MATCH_NOTICE_VERSION
        : NOTICE_VERSION;
    const result = await send({ type: 'consent:decide', accepted, noticeVersion });
    if (result.ok) return; // the service worker navigates to setup or closes this tab
    if (result.error === 'wrong_state') {
      inactive();
      return;
    }
    // Only accepting can fail (declining always succeeds locally).
    error.hidden = false;
    retry.disabled = false;
    retry.focus();
    agree.disabled = !checkbox.checked;
    decline.disabled = false;
  };
  agree.addEventListener('click', () => void decide(true));
  retry.addEventListener('click', () => void decide(true));
  decline.addEventListener('click', () => void decide(false));

  app.replaceChildren(
    el('h1', { text: notice.title }),
    el('p', { text: notice.intro }),
    ...notice.sections.flatMap((s) => [
      el('h2', { text: s.heading }),
      el('ul', {}, ...s.items.map((item) => el('li', { text: item }))),
    ]),
    label,
    ...faceMatch,
    el('div', { className: 'actions' }, agree, decline),
    error,
    el('p', { className: 'muted', text: notice.declineNote }),
  );
}

void main();
