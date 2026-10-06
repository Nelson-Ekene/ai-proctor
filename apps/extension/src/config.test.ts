import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, parseExtensionConfig, parseOrigin, toMatchPattern } from './config';

describe('parseOrigin', () => {
  it.each([
    'https://exam.example.com',
    'https://exam.example.com:8443',
    'http://localhost:4400',
    'http://127.0.0.1:1',
  ])('accepts %s', (o) => {
    expect(parseOrigin(o)).toBe(o);
  });

  it.each([
    ['http://exam.example.com', /https/],
    ['ftp://localhost', /https/],
    ['https://exam.example.com/', /bare origin/],
    ['https://exam.example.com/path', /bare origin/],
    ['https://*.example.com', /Invalid origin host/],
    ['not a url', /Invalid origin/],
  ])('rejects %s', (o, message) => {
    expect(() => parseOrigin(o)).toThrow(message);
  });
});

describe('parseExtensionConfig', () => {
  it('defaults to the local mock host and API', () => {
    expect(parseExtensionConfig({})).toEqual({
      examOrigins: ['http://localhost:4400'],
      apiOrigins: ['http://localhost:4401'],
    });
  });

  it('parses, trims and dedupes comma-separated lists', () => {
    expect(
      parseExtensionConfig({
        PROCTOR_EXAM_ORIGINS: ' https://a.example , https://b.example,https://a.example',
        PROCTOR_API_ORIGINS: 'https://api.example',
      }),
    ).toEqual({
      examOrigins: ['https://a.example', 'https://b.example'],
      apiOrigins: ['https://api.example'],
    });
  });

  it('requires at least one origin', () => {
    expect(() => parseExtensionConfig({ PROCTOR_EXAM_ORIGINS: ' , ' })).toThrow(/at least one/);
  });
});

describe('origin helpers', () => {
  it('builds a match pattern scoped to one origin', () => {
    expect(toMatchPattern('https://exam.example')).toBe('https://exam.example/*');
  });

  it('matches exact origins only', () => {
    const allowed = ['https://exam.example'];
    expect(isAllowedOrigin('https://exam.example/test?q=1', allowed)).toBe(true);
    expect(isAllowedOrigin('https://exam.example.evil.com/', allowed)).toBe(false);
    expect(isAllowedOrigin('http://exam.example/', allowed)).toBe(false);
    expect(isAllowedOrigin('garbage', allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });
});
