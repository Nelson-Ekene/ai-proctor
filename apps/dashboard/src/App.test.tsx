import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { tokenStore } from './api/client';
import {
  ADMIN,
  mockApi,
  prdReport,
  renderApp,
  REVIEWER,
  SESSION_ID,
  SESSION_LIST,
  T0,
} from './test/fixtures';

const report = prdReport();
const phone = report.violations.find((v) => v.type === 'phone_detected');
const frame = phone?.evidence.find((e) => e.kind === 'frame');
const seq = phone?.evidence.find((e) => e.kind === 'event_sequence');

function reviewerApi(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /v1/me': () => REVIEWER,
    'GET /v1/exams': () => [],
    'GET /v1/sessions': () => SESSION_LIST,
    [`GET /v1/sessions/${SESSION_ID}/report`]: () => report,
    ...extra,
  });
}

describe('sign in', () => {
  it('signs in and shows the ranked session list', async () => {
    const { calls } = reviewerApi({
      'POST /v1/auth/login': () => ({ token: 'put_new', expiresAt: '', role: 'reviewer' }),
    });
    renderApp({ signedIn: false });
    await userEvent.type(screen.getByLabelText('E-mail'), 'reviewer@a.test');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('table', { name: 'Sessions ranked by risk' }),
    ).toBeInTheDocument();
    expect(tokenStore.get()).toBe('put_new');
    expect(calls).toContain('POST /v1/auth/login');
  });

  it('explains a rejected sign-in without verdict wording', async () => {
    mockApi({
      'POST /v1/auth/login': () =>
        new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 }),
    });
    renderApp({ signedIn: false });
    await userEvent.type(screen.getByLabelText('E-mail'), 'x@a.test');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in');
  });

  it('returns to sign-in when the token expires', async () => {
    mockApi({ 'GET /v1/me': () => new Response('{}', { status: 401 }) });
    renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(tokenStore.get()).toBeNull();
  });
});

describe('session list', () => {
  it('ranks by risk with band badges and filters through the API', async () => {
    const { calls } = reviewerApi();
    renderApp();
    const table = await screen.findByRole('table', { name: 'Sessions ranked by risk' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('49.0');
    expect(rows[0]).toHaveTextContent('Medium risk');
    expect(rows[1]).toHaveTextContent('Low risk');

    await userEvent.selectOptions(screen.getByLabelText('Risk band'), 'high');
    await waitFor(() => {
      expect(calls.some((c) => c.startsWith('GET /v1/sessions?') && c.includes('band=high'))).toBe(
        true,
      );
    });
    expect(window.location.search).toBe('?band=high');
  });
});

describe('report: trace every point to a violation and its evidence', () => {
  it('shows score, band, category contributions, timeline and violations', async () => {
    reviewerApi();
    renderApp({ path: `/sessions/${SESSION_ID}` });
    expect(await screen.findByTestId('risk-score')).toHaveTextContent('49.0');
    expect(screen.getAllByText('Medium risk').length).toBeGreaterThan(0);

    const categories = screen.getByRole('table', { name: 'Contribution by category' });
    const rows = within(categories).getAllByRole('row');
    expect(rows[1]).toHaveTextContent(/Browser\s*50\s*50\.0\s*40%\s*20\.0/);
    expect(rows[2]).toHaveTextContent(/Video\s*60\s*60\.0\s*40%\s*24\.0/);
    expect(rows[3]).toHaveTextContent(/Audio\s*25\s*25\.0\s*20%\s*5\.0/);
    expect(rows[4]).toHaveTextContent(/Risk score\s*49\.0/);

    const flagged = screen.getByRole('table', { name: 'Flagged moments' });
    expect(within(flagged).getAllByRole('row')).toHaveLength(report.violations.length + 1);
    // Points per violation add up to the category points.
    const browserPoints = report.violations
      .filter((v) => v.category === 'browser')
      .reduce((s, v) => s + v.points, 0);
    expect(browserPoints).toBe(50);

    expect(
      within(screen.getByRole('list', { name: 'Timeline' })).getAllByRole('listitem'),
    ).toHaveLength(report.violations.length);
    expect(screen.getByText(/Score recomputed from the stored violations/)).toBeInTheDocument();
    expect(screen.getByText(/second device or screen is out of scope/)).toBeInTheDocument();
  });

  it('opens a violation and shows its frame, event sequence and points formula', async () => {
    const { calls } = reviewerApi({
      [`GET /v1/sessions/${SESSION_ID}/evidence/${frame?.id ?? ''}/url`]: () => ({
        url: 'https://storage.test/evidence/abc?X-Amz-Expires=60',
        expiresAt: '',
        kind: 'frame',
        contentType: 'image/jpeg',
      }),
      [`GET /v1/sessions/${SESSION_ID}/evidence/${seq?.id ?? ''}/events`]: () => ({
        from: (phone?.firstTs ?? 0) - 30_000,
        to: (phone?.firstTs ?? 0) + 15_000,
        events: [
          { type: 'window_blur', ts: (phone?.firstTs ?? 0) - 4_000 },
          { type: 'window_focus', ts: (phone?.firstTs ?? 0) + 9_000 },
        ],
      }),
    });
    renderApp({ path: `/sessions/${SESSION_ID}` });
    const flagged = await screen.findByRole('table', { name: 'Flagged moments' });
    await userEvent.click(
      within(flagged).getAllByRole('button', { name: 'Phone in view' })[0] as HTMLElement,
    );

    const evidence = screen.getByRole('region', { name: 'Evidence' });
    expect(evidence).toHaveTextContent('Points: 30 × 1.00 = 30');
    const img = await within(evidence).findByRole('img');
    expect(img).toHaveAttribute('src', 'https://storage.test/evidence/abc?X-Amz-Expires=60');
    const events = await within(evidence).findByRole('list', { name: 'Browser events' });
    expect(events).toHaveTextContent('-4.0 s');
    expect(events).toHaveTextContent('Browser window lost focus');
    expect(calls).toContain(`GET /v1/sessions/${SESSION_ID}/evidence/${frame?.id ?? ''}/url`);
  });

  it('plays audio evidence through a signed URL', async () => {
    const speech = report.violations.find((v) => v.type === 'speech_detected');
    const clip = speech?.evidence.find((e) => e.kind === 'audio');
    reviewerApi({
      [`GET /v1/sessions/${SESSION_ID}/evidence/${clip?.id ?? ''}/url`]: () => ({
        url: 'https://storage.test/clip',
        expiresAt: '',
        kind: 'audio',
        contentType: 'audio/wav',
      }),
      [`GET /v1/sessions/${SESSION_ID}/evidence/${speech?.evidence[0]?.id ?? ''}/events`]: () => ({
        from: T0,
        to: T0,
        events: [],
      }),
    });
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await userEvent.click(
      (await screen.findAllByRole('button', { name: /^Speech at/ }))[0] as HTMLElement,
    );
    const audio = await screen.findByLabelText(/Audio clip at/);
    expect(audio).toHaveAttribute('src', 'https://storage.test/clip');
  });

  it('marks evidence that has not arrived yet', async () => {
    const pending = prdReport();
    for (const e of pending.violations[0]?.evidence ?? []) e.uploaded = false;
    reviewerApi({ [`GET /v1/sessions/${SESSION_ID}/report`]: () => pending });
    renderApp({ path: `/sessions/${SESSION_ID}` });
    const flagged = await screen.findByRole('table', { name: 'Flagged moments' });
    await userEvent.click(within(flagged).getAllByRole('row')[1] as HTMLElement);
    expect(screen.getByRole('region', { name: 'Evidence' })).toHaveTextContent('Not received yet');
  });

  it('exports PDF and JSON through the audited API routes', async () => {
    const { calls } = reviewerApi({
      [`GET /v1/sessions/${SESSION_ID}/report.pdf`]: () => new Response(new Blob(['%PDF-1.3'])),
      [`GET /v1/sessions/${SESSION_ID}/report.json`]: () => report,
    });
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => undefined;
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Export PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => {
      expect(calls).toContain(`GET /v1/sessions/${SESSION_ID}/report.pdf`);
      expect(calls).toContain(`GET /v1/sessions/${SESSION_ID}/report.json`);
    });
  });

  it('shows the policy used for the score', async () => {
    reviewerApi();
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await userEvent.click(await screen.findByText(/Policy used for this score/));
    expect(screen.getByText(/Browser 40%, video 40%, audio 20%/)).toBeInTheDocument();
  });
});

describe('deleting a session', () => {
  it('lets an admin delete after a second confirmation, then returns to the list', async () => {
    let deleted = false;
    const { calls } = reviewerApi({
      'GET /v1/me': () => ADMIN,
      [`DELETE /v1/sessions/${SESSION_ID}`]: () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete session' }));
    // Cancel first: nothing is sent.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleted).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete session' });
    expect(dialog).toHaveTextContent(/cannot be undone/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
    expect(deleted).toBe(true);
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([
      `DELETE /v1/sessions/${SESSION_ID}`,
    ]);
  });

  it('keeps the report and says so when deleting fails', async () => {
    reviewerApi({
      'GET /v1/me': () => ADMIN,
      [`DELETE /v1/sessions/${SESSION_ID}`]: () =>
        new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 500 }),
    });
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete session' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not delete the session/);
    expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
  });

  it('is not offered to reviewers', async () => {
    reviewerApi();
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await screen.findByRole('button', { name: 'Export PDF' });
    expect(screen.queryByRole('button', { name: 'Delete session' })).not.toBeInTheDocument();
  });
});

describe('pilot metrics', () => {
  it('reports visible review time when the reviewer leaves a report', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const sent: unknown[] = [];
    reviewerApi({
      [`POST /v1/sessions/${SESSION_ID}/review-time`]: (init) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ path: `/sessions/${SESSION_ID}` });
    await screen.findByTestId('risk-score');
    now = 42_000;
    await userEvent.click(screen.getByRole('link', { name: '← All sessions' }));
    await waitFor(() => {
      expect(sent).toEqual([{ ms: 42_000 }]);
    });
    clock.mockRestore();
  });

  it('shows admins the metrics and audit log', async () => {
    mockApi({
      'GET /v1/me': () => ADMIN,
      'GET /v1/metrics': () => ({
        since: null,
        sessions: 4,
        violations: { total: 10, withEvidence: 10, evidenceLinkedRate: 1 },
        evidence: { referenced: 20, uploaded: 19, uploadedRate: 0.95 },
        setupCheck: { consented: 4, completed: 3, completionRate: 0.75, allReady: 2 },
        reviewerTime: { reviewedSessions: 2, medianMs: 90_000, p90Ms: 120_000, meanMs: 100_000 },
      }),
      'GET /v1/audit': () => [
        {
          id: 'a1',
          actorType: 'user',
          actorId: 'u2',
          action: 'evidence.view',
          targetType: 'evidence',
          targetId: 's/e',
          details: null,
          ts: new Date(T0).toISOString(),
        },
      ],
    });
    renderApp({ path: '/metrics' });
    expect(await screen.findByTestId('evidence-linked')).toHaveTextContent('100.0%');
    expect(screen.getByTestId('setup-completion')).toHaveTextContent('75.0%');
    expect(screen.getByTestId('review-median')).toHaveTextContent('1.5 min');
    expect(screen.getByRole('table', { name: 'Audit log' })).toHaveTextContent('evidence.view');
    expect(screen.getByRole('link', { name: 'Metrics' })).toBeInTheDocument();
  });

  it('hides metrics from reviewers', async () => {
    reviewerApi();
    renderApp();
    await screen.findByRole('table', { name: 'Sessions ranked by risk' });
    expect(screen.queryByRole('link', { name: 'Metrics' })).not.toBeInTheDocument();
  });
});
