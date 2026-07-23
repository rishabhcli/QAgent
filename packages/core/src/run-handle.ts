import type { Run, RunEvent } from '@qagent/contracts';
import type { QAgentStorage } from '@qagent/storage';
import type { AsyncQueue } from './async-queue.js';

export interface RunHandle {
  readonly id: string;
  events(afterSequence?: number): AsyncIterable<RunEvent>;
  cancel(reason?: string): Promise<void>;
  result(): Promise<Run>;
}

export class ActiveRunHandle implements RunHandle {
  constructor(
    readonly id: string,
    private readonly storage: QAgentStorage,
    private readonly queue: AsyncQueue<RunEvent>,
    private readonly completion: Promise<Run>,
    private readonly cancelRun: (reason?: string) => Promise<void>
  ) {}

  async *events(afterSequence = 0): AsyncIterable<RunEvent> {
    let cursor = afterSequence;
    for (const event of this.storage.listEvents(this.id, cursor)) {
      cursor = event.sequence;
      yield event;
    }
    for await (const event of this.queue) {
      if (event.sequence <= cursor) continue;
      cursor = event.sequence;
      yield event;
    }
  }

  cancel(reason?: string): Promise<void> {
    return this.cancelRun(reason);
  }

  result(): Promise<Run> {
    return this.completion;
  }
}
