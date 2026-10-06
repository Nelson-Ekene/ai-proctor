import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@proctor/core scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@proctor/core');
  });
});
