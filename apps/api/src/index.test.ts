import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@proctor/api scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@proctor/api');
  });
});
