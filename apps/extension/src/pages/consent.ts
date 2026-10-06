import { NOTICE_VERSION } from '../messages';
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
  const error = el('p', { className: 'error', id: 'error' });
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

  const decide = async (accepted: boolean) => {
    agree.disabled = decline.disabled = true;
    error.hidden = true;
    const result = await send({ type: 'consent:decide', accepted, noticeVersion: NOTICE_VERSION });
    if (result.ok) return; // the service worker navigates to setup or closes this tab
    if (result.error === 'wrong_state') {
      inactive();
      return;
    }
    error.textContent =
      'We could not save your choice. Check your internet connection and try again.';
    error.hidden = false;
    agree.disabled = !checkbox.checked;
    decline.disabled = false;
  };
  agree.addEventListener('click', () => void decide(true));
  decline.addEventListener('click', () => void decide(false));

  app.replaceChildren(
    el('h1', { text: notice.title }),
    el('p', { text: notice.intro }),
    ...notice.sections.flatMap((s) => [
      el('h2', { text: s.heading }),
      el('ul', {}, ...s.items.map((item) => el('li', { text: item }))),
    ]),
    label,
    el('div', { className: 'actions' }, agree, decline),
    error,
    el('p', { className: 'muted', text: notice.declineNote }),
  );
}

void main();
