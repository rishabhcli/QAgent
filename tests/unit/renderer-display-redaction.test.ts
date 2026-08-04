import { describe, expect, it } from 'vitest';
import { redactDisplayValue } from '../../apps/desktop/src/renderer/display-redaction.js';

describe('renderer display redaction', () => {
  it('keeps command structure while hiding environment values and sensitive fields', () => {
    expect(
      redactDisplayValue({
        executable: 'pnpm',
        args: ['test'],
        env: { API_TOKEN: 'token-value', NODE_ENV: 'test' },
        nested: { authorization: 'Bearer credential', timeoutMs: 300_000 },
      })
    ).toEqual({
      executable: 'pnpm',
      args: ['test'],
      env: { API_TOKEN: '<configured>', NODE_ENV: '<configured>' },
      nested: { authorization: '[REDACTED]', timeoutMs: 300_000 },
    });
  });
});
