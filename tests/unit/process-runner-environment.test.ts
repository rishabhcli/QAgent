import { commandEnvironment } from '@qagent/adapters';
import { describe, expect, it } from 'vitest';

describe('repository command environment', () => {
  it('does not inherit provider or host credentials', () => {
    const environment = commandEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        CI: 'true',
        OPENAI_API_KEY: 'model-secret',
        GITHUB_TOKEN: 'github-secret',
        AWS_ACCESS_KEY_ID: 'cloud-secret',
        DATABASE_URL: 'postgres://credential@example.test/db',
        HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example.test:8443',
        QAGENT_OPENAI_BASE_URL: 'https://model-user:model-password@models.example.test/v1',
        WANDB_BASE_URL: 'https://weave-user:weave-password@api.wandb.ai',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
      },
      {}
    );

    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      CI: 'true',
    });
  });

  it('keeps credential-free proxies but does not expose inherited proxy authentication', () => {
    const environment = commandEnvironment({
      HTTP_PROXY: 'http://proxy.example.test:8080',
      HTTPS_PROXY: 'https://user:password@proxy.example.test:8443',
      ALL_PROXY: 'socks5://user:password@proxy.example.test:1080',
    });

    expect(environment).toEqual({ HTTP_PROXY: 'http://proxy.example.test:8080' });
  });

  it('retains command-specific values that were explicitly disclosed in configuration', () => {
    const environment = commandEnvironment(
      { PATH: '/usr/bin', GITHUB_TOKEN: 'inherited-secret' },
      { GITHUB_TOKEN: 'explicit-test-value', TEST_MODE: 'integration' }
    );

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'explicit-test-value',
      TEST_MODE: 'integration',
    });
  });
});
