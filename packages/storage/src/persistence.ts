import type { BoundedOutput } from '@qagent/contracts';

const SECRET_KEY =
  /(^|[_-])(access[_-]?key|api[_-]?key|authorization|cookie|credentials?|password|passwd|private[_-]?key|secret|token)([_-]|$)/i;
const SECRET_ASSIGNMENT =
  /((?:api[-_]?key|token|secret|password|passwd|authorization|cookie|credential)\s*[:=]\s*)(["']?)[^\s,;"']+\2/gi;
const SECRET_VALUE = /(bearer\s+)[a-z0-9._~+/=-]+|(?:sk|rk|pk|gh[pousr])[-_][a-z0-9_-]{8,}/gi;
const URL_SECRET =
  /([?&](?:access_token|api_key|apikey|authorization|password|secret|token)=)[^&#\s]+/gi;
const URL_BASIC_AUTH = /(https?:\/\/)[^/\s@]+:[^/\s@]*@/gi;
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const REDACTED = '[REDACTED]';
const OUTPUT_TRUNCATION_MARKER = '\n[QAGENT OUTPUT TRUNCATED]\n';

export interface RedactionResult {
  text: string;
  replacementCount: number;
}

export interface ValueRedactionResult<T> {
  value: T;
  replacementCount: number;
}

export interface PersistenceRedactorOptions {
  secretValues?: Iterable<string | undefined | null>;
  environment?: NodeJS.ProcessEnv;
}

export class PersistenceRedactor {
  private secretValues: string[] = [];
  private redactionMarker = REDACTED;
  private outputTruncationMarker = OUTPUT_TRUNCATION_MARKER;

  constructor(options: PersistenceRedactorOptions = {}) {
    this.registerSecrets(options.secretValues ?? []);
    const environmentSecrets: Array<string | undefined | null> = [];
    for (const [key, value] of Object.entries(options.environment ?? process.env)) {
      if (value && SECRET_KEY.test(key)) environmentSecrets.push(value);
    }
    this.registerDiscoveredSecrets(environmentSecrets);
  }

  registerSecrets(values: Iterable<string | undefined | null>): void {
    this.addSecrets(values, 1);
  }

  private registerDiscoveredSecrets(values: Iterable<string | undefined | null>): void {
    this.addSecrets(values, 4);
  }

  private addSecrets(values: Iterable<string | undefined | null>, minimumLength: number): void {
    const combined = new Set(this.secretValues);
    for (const value of values) {
      if (value && value.length >= minimumLength) combined.add(value);
    }
    this.secretValues = [...combined].sort((left, right) => right.length - left.length);
    this.redactionMarker = this.secretValues.some((secret) => REDACTED.includes(secret))
      ? ''
      : REDACTED;
    this.outputTruncationMarker = this.secretValues.some((secret) =>
      OUTPUT_TRUNCATION_MARKER.includes(secret)
    )
      ? ''
      : OUTPUT_TRUNCATION_MARKER;
  }

  redactText(input: string): RedactionResult {
    let text = input;
    let replacementCount = 0;
    const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
      text = text.replace(pattern, (...args: string[]) => {
        replacementCount += 1;
        return typeof replacement === 'string' ? replacement : replacement(...args);
      });
    };

    replace(PRIVATE_KEY, this.redactionMarker);
    replace(URL_BASIC_AUTH, (_match, scheme: string) => `${scheme}${this.redactionMarker}@`);
    replace(URL_SECRET, (_match, prefix: string) => `${prefix}${this.redactionMarker}`);
    replace(SECRET_VALUE, (match: string, bearerPrefix?: string) =>
      bearerPrefix ? `${bearerPrefix}${this.redactionMarker}` : this.redactionMarker
    );
    replace(SECRET_ASSIGNMENT, (_match, prefix: string) => `${prefix}${this.redactionMarker}`);
    for (const secret of this.secretValues) {
      if (!text.includes(secret)) continue;
      const pieces = text.split(secret);
      replacementCount += pieces.length - 1;
      text = pieces.join(this.redactionMarker);
    }
    return { text, replacementCount };
  }

  redactValue<T>(value: T, key = ''): T {
    return this.redactValueWithCount(value, key).value;
  }

  redactValueWithCount<T>(value: T, key = ''): ValueRedactionResult<T> {
    if (SECRET_KEY.test(key) && typeof value === 'string') {
      return {
        value: this.redactionMarker as T,
        replacementCount: value === this.redactionMarker ? 0 : 1,
      };
    }
    if (typeof value === 'string') {
      const redacted = this.redactText(value);
      return { value: redacted.text as T, replacementCount: redacted.replacementCount };
    }
    if (Array.isArray(value)) {
      const children = value.map((item) => this.redactValueWithCount(item));
      return {
        value: children.map((child) => child.value) as T,
        replacementCount: children.reduce((total, child) => total + child.replacementCount, 0),
      };
    }
    if (value && typeof value === 'object') {
      let replacementCount = 0;
      const redacted = Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => {
          const result = this.redactValueWithCount(child, childKey);
          replacementCount += result.replacementCount;
          return [childKey, result.value];
        })
      ) as T;
      return { value: redacted, replacementCount };
    }
    return { value, replacementCount: 0 };
  }

  boundedOutput(input: string, limitBytes = 48 * 1_024): BoundedOutput {
    const redacted = this.redactText(input);
    const safeBytes = Buffer.from(redacted.text);
    if (safeBytes.byteLength <= limitBytes) {
      return {
        text: redacted.text,
        originalBytes: safeBytes.byteLength,
        retainedBytes: safeBytes.byteLength,
        omittedBytes: 0,
        truncated: false,
        redactionCount: redacted.replacementCount,
        backpressure: null,
      };
    }

    const marker = Buffer.from(this.outputTruncationMarker);
    const contentBudget = Math.max(0, limitBytes - marker.byteLength);
    const headBytes = Math.ceil(contentBudget / 2);
    const tailBytes = contentBudget - headBytes;
    const head = utf8Prefix(safeBytes, headBytes);
    const tail = utf8Suffix(safeBytes, tailBytes);
    const bounded = Buffer.concat([head, marker, tail]);
    const retainedBytes = head.byteLength + tail.byteLength;
    const omittedBytes = safeBytes.byteLength - retainedBytes;
    return {
      text: bounded.toString('utf8'),
      originalBytes: safeBytes.byteLength,
      retainedBytes,
      omittedBytes,
      truncated: true,
      redactionCount: redacted.replacementCount,
      backpressure: {
        droppedChunks: 1,
        droppedBytes: omittedBytes,
      },
    };
  }

  assertBinarySafe(input: Uint8Array): void {
    const decoded = Buffer.from(input).toString('utf8');
    if (this.redactText(decoded).replacementCount > 0) {
      throw new Error('Binary artifact contains recognized secret material');
    }
  }
}

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function utf8Prefix(value: Buffer, maximumBytes: number): Buffer {
  let end = Math.min(value.byteLength, maximumBytes);
  while (end > 0) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(0, end));
      return value.subarray(0, end);
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function utf8Suffix(value: Buffer, maximumBytes: number): Buffer {
  let start = Math.max(0, value.byteLength - maximumBytes);
  while (start < value.byteLength) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(start));
      return value.subarray(start);
    } catch {
      start += 1;
    }
  }
  return Buffer.alloc(0);
}
