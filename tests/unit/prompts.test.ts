import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  PATCH_SYSTEM_PROMPT,
  PatchOutputSchema,
  patchPrompt,
} from '../../packages/core/src/prompts.js';

describe('repair prompts', () => {
  it('teaches exact hunk range semantics using numbered repository context', () => {
    const prompt = patchPrompt({
      failure: 'src/counter.mjs failed',
      diagnosis: 'The increment is off by one.',
      context: 'FILE: src/counter.mjs\n000003|  return value + 2;',
    });

    expect(PATCH_SYSTEM_PROMPT).toContain(
      'OLD_COUNT equals context plus deleted lines; NEW_COUNT equals context plus added lines'
    );
    expect(prompt).toContain('000001|');
    expect(prompt).toContain('never copy those prefixes into the diff');
    expect(prompt).toContain('@@ -7,1 +7,1 @@\n-return oldValue;\n+return newValue;');
    expect(prompt).toContain('counts that disagree with the body are invalid');
  });

  it('carries the unified diff grammar in the structured output schema', () => {
    const schema = JSON.stringify(z.toJSONSchema(PatchOutputSchema));

    expect(schema).toContain('complete Git unified diff accepted by git apply');
    expect(schema).toContain('declared counts exactly match the hunk body');
  });
});
