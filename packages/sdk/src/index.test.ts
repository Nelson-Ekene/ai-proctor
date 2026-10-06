import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@proctor/sdk scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@proctor/sdk');
  });
});
