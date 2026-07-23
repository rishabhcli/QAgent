import type { RunEvent } from '@qagent/contracts';

export type TraceState = 'local' | 'queued' | 'synced' | 'failed' | 'disabled';

export interface TraceSink {
  readonly state: TraceState;
  send(event: RunEvent): Promise<TraceState>;
}

const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]+)/gi;

export function redactForTelemetry(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactForTelemetry(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactForTelemetry(child, childKey),
      ])
    );
  }
  return value;
}

export class LocalTraceSink implements TraceSink {
  readonly state: TraceState = 'local';
  async send(_event: RunEvent): Promise<TraceState> {
    return this.state;
  }
}

export class DisabledTraceSink implements TraceSink {
  readonly state: TraceState = 'disabled';
  async send(_event: RunEvent): Promise<TraceState> {
    return this.state;
  }
}

interface WeaveModule {
  init(project: string): Promise<unknown>;
  op<T extends (input: Record<string, unknown>) => Promise<Record<string, unknown>>>(
    fn: T,
    options: {
      name: string;
      postprocessInputs: (inputs: unknown) => unknown;
      postprocessOutput: (output: unknown) => unknown;
    }
  ): T;
}

export class WeaveTraceSink implements TraceSink {
  state: TraceState = 'queued';
  private operation: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
    null;

  constructor(
    private readonly project: string,
    private readonly acceptedDisclosure: boolean
  ) {}

  async send(event: RunEvent): Promise<TraceState> {
    if (!this.acceptedDisclosure || !process.env.WANDB_API_KEY) {
      this.state = 'disabled';
      return this.state;
    }
    try {
      if (!this.operation) await this.initialize();
      await this.operation?.({ event: redactForTelemetry(event) });
      this.state = 'synced';
    } catch {
      this.state = 'failed';
    }
    return this.state;
  }

  private async initialize(): Promise<void> {
    const weave = (await import('weave')) as unknown as WeaveModule;
    await weave.init(this.project);
    this.operation = weave.op(async (input) => input, {
      name: 'qagent.run.event',
      postprocessInputs: (inputs) => redactForTelemetry(inputs),
      postprocessOutput: (output) => redactForTelemetry(output),
    });
  }
}
