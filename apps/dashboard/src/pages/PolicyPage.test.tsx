import { DEFAULT_POLICY, type Policy } from '@proctor/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PolicyView } from '../api/types';
import {
  ADMIN,
  mockApi,
  prdReport,
  renderApp,
  REVIEWER,
  SESSION_ID,
  SESSION_LIST,
} from '../test/fixtures';

const VIEW: PolicyView = {
  examId: null,
  effective: { policy: DEFAULT_POLICY, versionId: null, version: null, source: 'default' },
  versions: [],
};

function policyApi(me: typeof ADMIN, saved: Policy[] = []) {
  return mockApi({
    'GET /v1/me': () => me,
    'GET /v1/exams': () => [{ id: 'e1', name: 'Physics', createdAt: '' }],
    'GET /v1/policies': () => VIEW,
    'GET /v1/sessions': () => SESSION_LIST,
    [`GET /v1/sessions/${SESSION_ID}/report`]: () => prdReport(),
    'PUT /v1/policies': (init) => {
      saved.push((JSON.parse(init.body as string) as { policy: Policy }).policy);
      return { id: 'p1', version: 1 };
    },
  });
}

async function weightInput(name: string): Promise<HTMLInputElement> {
  return screen.findByRole<HTMLInputElement>('spinbutton', { name });
}

describe('policy settings', () => {
  it('enforces weights summing to 100 before saving', async () => {
    policyApi(ADMIN);
    renderApp({ path: '/policy' });
    const browser = await weightInput('Browser');
    await userEvent.clear(browser);
    await userEvent.type(browser, '50');
    expect(screen.getByTestId('weight-sum')).toHaveTextContent('Total 110%');
    expect(screen.getByRole('alert')).toHaveTextContent('Weights must add up to 100 (now 110).');
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled();
  });

  it('previews the score impact on a sample session, then saves a new version', async () => {
    const saved: Policy[] = [];
    policyApi(ADMIN, saved);
    renderApp({ path: '/policy' });
    expect(await screen.findByTestId('preview-current')).toHaveTextContent('49.0');

    // Move 20 points of weight from browser to video: 0.2*50 + 0.6*60 + 0.2*25 = 51.
    const browser = await weightInput('Browser');
    const video = await weightInput('Video');
    await userEvent.clear(browser);
    await userEvent.type(browser, '20');
    await userEvent.clear(video);
    await userEvent.type(video, '60');
    await waitFor(() => {
      expect(screen.getByTestId('preview-new')).toHaveTextContent('51.0');
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as version 1');
    expect(saved[0]?.weights).toEqual({ browser: 0.2, video: 0.6, audio: 0.2 });
  });

  it('is read-only for reviewers', async () => {
    policyApi(REVIEWER);
    renderApp({ path: '/policy' });
    expect(await weightInput('Browser')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save new version' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only admins can change the policy/)).toBeInTheDocument();
  });
});
