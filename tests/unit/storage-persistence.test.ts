import { PersistenceRedactor } from '@qagent/storage';
import { describe, expect, it } from 'vitest';

describe('PersistenceRedactor boundaries', () => {
  it('honors explicitly registered short secrets without reintroducing them in its marker', () => {
    const redactor = new PersistenceRedactor({
      secretValues: ['abc'],
      environment: {},
    });

    expect(redactor.redactText('binary-abc-bytes')).toEqual({
      text: 'binary-[REDACTED]-bytes',
      replacementCount: 1,
    });
    expect(() => redactor.assertBinarySafe(Buffer.from('binary-abc-bytes'))).toThrow(
      /secret material/
    );

    const markerCollision = new PersistenceRedactor({
      secretValues: ['R'],
      environment: {},
    });
    expect(markerCollision.redactText('R')).toEqual({
      text: '',
      replacementCount: 1,
    });
    const bounded = markerCollision.boundedOutput(`${'x'.repeat(128)}R`, 16);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).not.toContain('R');
  });

  it('does not promote short ambient environment values to global scrub rules', () => {
    const redactor = new PersistenceRedactor({
      environment: { API_KEY: 'a' },
    });

    expect(redactor.redactText('safe data')).toEqual({
      text: 'safe data',
      replacementCount: 0,
    });
  });

  it('redacts HTTP Basic userinfo before URLs reach persistence', () => {
    const redactor = new PersistenceRedactor({ environment: {} });
    const result = redactor.redactText(
      'Open https://alice:basic-pass-9327@example.com/private and http://bob:p@localhost:3000/'
    );

    expect(result.text).toBe(
      'Open https://[REDACTED]@example.com/private and http://[REDACTED]@localhost:3000/'
    );
    expect(result.text).not.toContain('alice');
    expect(result.text).not.toContain('basic-pass-9327');
    expect(result.text).not.toContain('bob');
    expect(result.replacementCount).toBe(2);

    const shortSecret = new PersistenceRedactor({
      secretValues: ['p'],
      environment: {},
    }).redactText('https://alice:another-password@example.com/');
    expect(shortSecret.text).not.toContain('alice');
    expect(shortSecret.text).not.toContain('another-password');
  });

  it('redacts private keys and both bearer and prefixed credential forms', () => {
    const redactor = new PersistenceRedactor({ environment: {} });
    const result = redactor.redactText(
      [
        '-----BEGIN PRIVATE KEY-----',
        'private-material',
        '-----END PRIVATE KEY-----',
        'Authorization: Bearer opaque-token-123',
        'key=sk_live_fixture1234',
      ].join('\n')
    );

    expect(result.text).not.toContain('private-material');
    expect(result.text).not.toContain('opaque-token-123');
    expect(result.text).not.toContain('sk_live_fixture1234');
    expect(result.replacementCount).toBeGreaterThanOrEqual(3);
  });
});
