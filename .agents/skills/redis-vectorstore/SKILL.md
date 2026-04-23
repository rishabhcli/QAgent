# Skill: Redis Vector Store

## When to Use This Skill

Use this skill when:
- Implementing the knowledge base for QAgent
- Storing failure traces with embeddings
- Retrieving similar past failures
- Storing and retrieving fix patterns
- Integrating Redis with Triage and Fixer agents

Do NOT use this skill when:
- Working on browser automation (use browserbase-stagehand)
- Implementing deployment logic (use vercel-deployment)

---

## Overview

Redis Stack provides vector search capabilities that enable semantic similarity search over failure traces and fix patterns. This is the "memory" that makes QAgent self-improving - it learns from past bugs to fix similar issues faster.

Key capabilities:
- Store failure traces with vector embeddings
- Semantic search for similar past failures
- Associate fixes with failure patterns
- Fast retrieval for real-time agent use

---

## Key Concepts

### Vector Embeddings

We convert error messages and stack traces into numerical vectors (embeddings) using OpenAI's embedding model. Similar errors will have similar vectors, enabling semantic search.

```typescript
const embedding = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: errorMessage
});
// Returns 1536-dimensional vector
```

### Redis Vector Index

Redis Stack supports HNSW (Hierarchical Navigable Small World) indexes for efficient similarity search.

```typescript
await redis.call(
  'FT.CREATE', 'failure_idx',
  'ON', 'HASH',
  'PREFIX', '1', 'failure:',
  'SCHEMA',
    'embedding', 'VECTOR', 'HNSW', '6',
      'TYPE', 'FLOAT32',
      'DIM', '1536',
      'DISTANCE_METRIC', 'COSINE',
    'error_message', 'TEXT',
    'failure_type', 'TAG',
    'file', 'TAG'
);
```

### KNN Search

Find the K nearest neighbors to a query vector:

```typescript
const results = await redis.call(
  'FT.SEARCH', 'failure_idx',
  '*=>[KNN 5 @embedding $vec AS score]',
  'PARAMS', '2', 'vec', queryVector,
  'SORTBY', 'score',
  'RETURN', '3', 'error_message', 'fix_diff', 'score'
);
```

---

## Common Patterns

### Store Failure Trace

```typescript
async function storeFailure(
  failure: FailureTrace,
  embedding: number[]
): Promise<void> {
  const id = `failure:${failure.id}`;
  const vectorBuffer = Buffer.from(new Float32Array(embedding).buffer);

  await redis.hSet(id, {
    embedding: vectorBuffer,
    error_message: failure.errorMessage,
    stack_trace: failure.stackTrace,
    file: failure.file,
    line: failure.line.toString(),
    failure_type: failure.failureType,
    fix_description: failure.fix?.description || '',
    fix_diff: failure.fix?.diff || '',
    success: failure.fix?.success ? '1' : '0',
    created_at: Date.now().toString()
  });
}
```

### Search Similar Failures

```typescript
async function findSimilarFailures(
  errorMessage: string,
  k: number = 5
): Promise<SimilarFailure[]> {
  // Generate embedding for query
  const embedding = await generateEmbedding(errorMessage);
  const vectorBuffer = Buffer.from(new Float32Array(embedding).buffer);

  // KNN search
  const results = await redis.call(
    'FT.SEARCH', 'failure_idx',
    '*=>[KNN $k @embedding $vec AS score]',
    'PARAMS', '4',
      'k', k.toString(),
      'vec', vectorBuffer,
    'SORTBY', 'score',
    'RETURN', '5', 'error_message', 'fix_description', 'fix_diff', 'file', 'score',
    'DIALECT', '2'
  );

  return parseSearchResults(results);
}
```

### Update with Fix

```typescript
async function recordSuccessfulFix(
  failureId: string,
  fix: { description: string; diff: string }
): Promise<void> {
  const id = `failure:${failureId}`;

  await redis.hSet(id, {
    fix_description: fix.description,
    fix_diff: fix.diff,
    success: '1'
  });
}
```

---

## Best Practices

1. **Use consistent embedding model** - Always use the same model (text-embedding-3-small)
2. **Include relevant context in embeddings** - Combine error message + stack trace
3. **Filter by failure type** - Use TAG filters to narrow search
4. **Set similarity threshold** - Only use matches with score > 0.8
5. **Clean old entries** - Set TTL or periodically prune

---

## Common Pitfalls

### Embedding Dimension Mismatch
- Index expects 1536 dimensions
- Ensure embedding model outputs correct size
- text-embedding-3-small = 1536 dim

### Buffer Encoding
- Redis expects Float32 buffer
- Use `Buffer.from(new Float32Array(embedding).buffer)`
- Don't send raw JavaScript array

### Index Not Created
- Create index before first search
- Use `FT.INFO` to check if index exists
- Handle "Index not found" error gracefully

---

## Related Skills

- `qagent-agents/` - Using Redis in Triage and Fixer agents
- `wandb-weave/` - Logging Redis query results

---

## References

- [Redis Vector Search](https://redis.io/docs/stack/search/reference/vectors/)
- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
- [Redis Stack Documentation](https://redis.io/docs/stack/)
