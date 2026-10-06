import { describe, expect, it } from 'vitest';
import { classifySender } from './sender';

const ID = 'akponalihmmaihgcnonegjelddajfdka';
const config = { examOrigins: ['http://localhost:4400'], apiOrigins: [] };

describe('classifySender', () => {
  it('recognises extension pages (with or without a tab)', () => {
    expect(
      classifySender(
        { id: ID, url: `chrome-extension://${ID}/src/pages/consent.html`, tab: { id: 3 } },
        ID,
        config,
      ),
    ).toEqual({
      kind: 'extension_page',
      tabId: 3,
    });
    expect(
      classifySender(
        { id: ID, url: `chrome-extension://${ID}/src/offscreen/offscreen.html` },
        ID,
        config,
      ),
    ).toEqual({
      kind: 'extension_page',
      tabId: undefined,
    });
  });

  it('recognises content scripts on exam origins', () => {
    expect(
      classifySender({ id: ID, url: 'http://localhost:4400/exam', tab: { id: 5 } }, ID, config),
    ).toEqual({
      kind: 'content_script',
      tabId: 5,
    });
  });

  it('treats everything else as unknown', () => {
    expect(
      classifySender({ id: 'other', url: `chrome-extension://${ID}/x.html` }, ID, config).kind,
    ).toBe('unknown');
    expect(
      classifySender({ id: ID, url: 'https://elsewhere.example/', tab: { id: 1 } }, ID, config)
        .kind,
    ).toBe('unknown');
    expect(classifySender({ id: ID, url: 'http://localhost:4400/exam' }, ID, config).kind).toBe(
      'unknown',
    ); // no tab
    expect(
      classifySender({ id: ID, url: 'chrome-extension://another/x.html' }, ID, config).kind,
    ).toBe('unknown');
    expect(classifySender({ id: ID, url: 'not a url' }, ID, config).kind).toBe('unknown');
    expect(classifySender({ id: ID }, ID, config).kind).toBe('unknown');
  });
});
