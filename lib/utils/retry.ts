export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: Array<string | RegExp>;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

function isRetryable(error: Error, patterns?: Array<string | RegExp>): boolean {
  if (!patterns || patterns.length === 0) return true;
  const msg = error.message;
  return patterns.some((p) =>
    typeof p === 'string' ? msg.includes(p) : p.test(msg)
  );
}

function calculateDelay(attempt: number, opts: RetryOptions): number {
  const base = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
  const capped = Math.min(base, opts.maxDelayMs);
  // Add jitter: +/- 10%
  const jitter = capped * 0.1 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      },
      { once: true }
    );
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new Error('Aborted');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === opts.maxRetries) break;
      if (!isRetryable(lastError, opts.retryableErrors)) break;

      const delay = calculateDelay(attempt, opts);
      opts.onRetry?.(attempt + 1, lastError, delay);

      await sleep(delay, opts.signal);
    }
  }

  throw lastError!;
}

// Circuit Breaker

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super('Circuit breaker is open');
    this.name = 'CircuitBreakerOpenError';
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_CB_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 60000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private opts: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.opts = { ...DEFAULT_CB_OPTIONS, ...options };
  }

  getState(): CircuitState {
    this.checkReset();
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenAttempts = 0;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkReset();

    if (this.state === 'open') {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private checkReset(): void {
    if (
      this.state === 'open' &&
      Date.now() - this.lastFailureTime >= this.opts.resetTimeoutMs
    ) {
      this.state = 'half-open';
      this.halfOpenAttempts = 0;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.reset();
    }
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.opts.halfOpenMaxAttempts) {
        this.state = 'open';
      }
    } else if (this.failures >= this.opts.failureThreshold) {
      this.state = 'open';
    }
  }
}
