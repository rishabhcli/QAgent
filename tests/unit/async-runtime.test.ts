import { join } from 'node:path';
import { createLocalRuntime, errorMessage } from '@qagent/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../packages/core/src/async-queue.js';
import { temporaryDirectory } from '../helpers.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('AsyncQueue', () => {
  it('delivers buffered and waiting values and ignores pushes after close', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(1);
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });

    const waiting = iterator.next();
    queue.push(2);
    await expect(waiting).resolves.toEqual({ value: 2, done: false });

    const completion = iterator.next();
    queue.close();
    queue.push(3);
    await expect(completion).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('rejects current and future consumers after failure', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.fail(new Error('queue failed'));
    await expect(waiting).rejects.toThrow('queue failed');
    await expect(iterator.next()).rejects.toThrow('queue failed');
  });
});

describe('runtime selection', () => {
  it('selects disabled, local, and disclosed Weave trace modes without changing storage', async () => {
    const root = await temporaryDirectory('qagent-runtime-modes-');
    const disabled = createLocalRuntime({
      home: join(root, 'disabled'),
      weaveEnabled: false,
      weaveDisclosureAccepted: true,
    });
    disabled.close();

    const local = createLocalRuntime({
      home: join(root, 'local'),
      weaveEnabled: true,
      weaveDisclosureAccepted: false,
    });
    local.close();

    process.env.WANDB_API_KEY = 'configured-for-construction-only';
    process.env.WEAVE_PROJECT = 'environment-project';
    const weave = createLocalRuntime({
      home: join(root, 'weave'),
      weaveEnabled: true,
      weaveDisclosureAccepted: true,
    });
    weave.close();

    const explicit = createLocalRuntime({
      home: join(root, 'explicit'),
      weaveEnabled: true,
      weaveDisclosureAccepted: true,
      weaveProject: 'explicit-project',
    });
    explicit.close();
  });

  it('uses QAGENT_HOME when no explicit runtime home is provided', async () => {
    const home = await temporaryDirectory('qagent-environment-home-');
    process.env.QAGENT_HOME = home;
    const runtime = createLocalRuntime({ weaveEnabled: false });
    expect(runtime.home).toBe(home);
    runtime.close();
  });
});

describe('error messages', () => {
  it('preserves Error messages and stringifies non-Error failures', () => {
    expect(errorMessage(new Error('failure'))).toBe('failure');
    expect(errorMessage({ code: 7 })).toBe('[object Object]');
  });
});
