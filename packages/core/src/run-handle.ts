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
    for (const event of this.replayAfter(cursor)) {
      cursor = event.sequence;
      yield event;
    }
    for await (const event of this.queue) {
      if (event.sequence <= cursor) continue;
      if (event.sequence > cursor + 1) {
        for (const replayed of this.replayAfter(cursor)) {
          if (replayed.sequence > event.sequence) break;
          cursor = replayed.sequence;
          yield replayed;
        }
      }
      if (event.sequence <= cursor) continue;
      if (event.sequence !== cursor + 1) {
        throw new Error(
          `Run event sequence gap: expected ${cursor + 1}, received ${event.sequence}`
        );
      }
      cursor = event.sequence;
      yield event;
    }
    for (const event of this.replayAfter(cursor)) {
      yield event;
    }
  }

  cancel(reason?: string): Promise<void> {
    return this.cancelRun(reason);
  }

  result(): Promise<Run> {
    return this.completion;
  }

  private replayAfter(afterSequence: number): RunEvent[] {
    const events: RunEvent[] = [];
    let cursor = afterSequence;
    while (true) {
      const page = this.storage.replayEvents({
        runId: this.id,
        afterSequence: cursor,
        limit: 500,
      });
      events.push(...page.events);
      cursor = page.nextSequence;
      if (!page.hasMore) return events;
    }
  }
}
