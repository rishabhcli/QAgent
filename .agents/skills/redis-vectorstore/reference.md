# Reference: Redis Vector Store

Copy-paste code patterns for the QAgent knowledge base.

---

## Quick Start

```typescript
import { createClient } from 'redis';
import OpenAI from 'openai';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Generate embedding
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: 'TypeError: Cannot read property onClick of undefined'
});
const embedding = response.data[0].embedding;

// Store in Redis
const vectorBuffer = Buffer.from(new Float32Array(embedding).buffer);
await redis.hSet('failure:001', {
  embedding: vectorBuffer,
  error_message: 'TypeError: Cannot read property onClick of undefined',
  file: 'Checkout.tsx'
});
```

---

## Code Patterns

### Pattern 1: Create Vector Index

**Use when:** Setting up the knowledge base for the first time

```typescript
import { createClient } from 'redis';

async function createFailureIndex(redis: ReturnType<typeof createClient>) {
  try {
    // Check if index exists
    await redis.ft.info('failure_idx');
    console.log('Index already exists');
  } catch (e) {
    // Create index
    await redis.ft.create('failure_idx', {
      '$.embedding': {
        type: 'VECTOR',
        AS: 'embedding',
        ALGORITHM: 'HNSW',
        TYPE: 'FLOAT32',
        DIM: 1536,
        DISTANCE_METRIC: 'COSINE'
      },
      '$.error_message': {
        type: 'TEXT',
        AS: 'error_message'
      },
      '$.failure_type': {
        type: 'TAG',
        AS: 'failure_type'
      },
      '$.file': {
        type: 'TAG',
        AS: 'file'
      },
      '$.success': {
        type: 'TAG',
        AS: 'success'
      },
      '$.created_at': {
        type: 'NUMERIC',
        AS: 'created_at',
        SORTABLE: true
      }
    }, {
      ON: 'JSON',
      PREFIX: 'failure:'
    });
    console.log('Index created');
  }
}
```

### Pattern 2: Store Failure with Embedding

**Use when:** Saving a new failure trace to the knowledge base

```typescript
import OpenAI from 'openai';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

interface FailureTrace {
  errorMessage: string;
  stackTrace: string;
  file: string;
  line: number;
  failureType: 'UI_BUG' | 'BACKEND_ERROR' | 'TEST_FLAKY' | 'DATA_ERROR';
  fix?: {
    description: string;
    diff: string;
    success: boolean;
  };
}

async function storeFailure(
  redis: ReturnType<typeof createClient>,
  openai: OpenAI,
  failure: FailureTrace
): Promise<string> {
  const id = uuidv4();

  // Generate embedding from error message + stack trace
  const textForEmbedding = `${failure.errorMessage}\n${failure.stackTrace}`;
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: textForEmbedding
  });
  const embedding = response.data[0].embedding;

  // Store as JSON document
  await redis.json.set(`failure:${id}`, '$', {
    id,
    embedding,
    error_message: failure.errorMessage,
    stack_trace: failure.stackTrace,
    file: failure.file,
    line: failure.line,
    failure_type: failure.failureType,
    fix_description: failure.fix?.description || null,
    fix_diff: failure.fix?.diff || null,
    success: failure.fix?.success || false,
    created_at: Date.now()
  });

  return id;
}
```

### Pattern 3: Search Similar Failures

**Use when:** Finding past failures similar to a new one

```typescript
interface SimilarFailure {
  id: string;
  errorMessage: string;
  file: string;
  fixDescription: string | null;
  fixDiff: string | null;
  success: boolean;
  similarity: number;
}

async function findSimilarFailures(
  redis: ReturnType<typeof createClient>,
  openai: OpenAI,
  errorMessage: string,
  stackTrace: string,
  k: number = 5,
  minSimilarity: number = 0.7
): Promise<SimilarFailure[]> {
  // Generate query embedding
  const textForEmbedding = `${errorMessage}\n${stackTrace}`;
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: textForEmbedding
  });
  const queryEmbedding = response.data[0].embedding;

  // Search
  const results = await redis.ft.search('failure_idx', '*=>[KNN $K @embedding $BLOB AS similarity]', {
    PARAMS: {
      K: k,
      BLOB: Buffer.from(new Float32Array(queryEmbedding).buffer)
    },
    RETURN: ['error_message', 'file', 'fix_description', 'fix_diff', 'success', 'similarity'],
    SORTBY: { BY: 'similarity', DIRECTION: 'ASC' },
    DIALECT: 2
  });

  // Filter by similarity threshold and parse
  return results.documents
    .filter((doc: any) => {
      const similarity = 1 - parseFloat(doc.value.similarity);
      return similarity >= minSimilarity;
    })
    .map((doc: any) => ({
      id: doc.id.replace('failure:', ''),
      errorMessage: doc.value.error_message,
      file: doc.value.file,
      fixDescription: doc.value.fix_description,
      fixDiff: doc.value.fix_diff,
      success: doc.value.success === 'true' || doc.value.success === true,
      similarity: 1 - parseFloat(doc.value.similarity)
    }));
}
```

### Pattern 4: Update Failure with Fix

**Use when:** Recording a successful fix for a failure

```typescript
async function recordFix(
  redis: ReturnType<typeof createClient>,
  failureId: string,
  fix: {
    description: string;
    diff: string;
    success: boolean;
  }
): Promise<void> {
  await redis.json.set(`failure:${failureId}`, '$.fix_description', fix.description);
  await redis.json.set(`failure:${failureId}`, '$.fix_diff', fix.diff);
  await redis.json.set(`failure:${failureId}`, '$.success', fix.success);
}
```

### Pattern 5: Get Fix Patterns for Bug Type

**Use when:** Retrieving all successful fixes for a specific failure type

```typescript
async function getFixPatternsForType(
  redis: ReturnType<typeof createClient>,
  failureType: string,
  limit: number = 10
): Promise<{ description: string; diff: string }[]> {
  const results = await redis.ft.search(
    'failure_idx',
    `@failure_type:{${failureType}} @success:{true}`,
    {
      RETURN: ['fix_description', 'fix_diff'],
      LIMIT: { from: 0, size: limit },
      SORTBY: { BY: 'created_at', DIRECTION: 'DESC' }
    }
  );

  return results.documents
    .filter((doc: any) => doc.value.fix_description && doc.value.fix_diff)
    .map((doc: any) => ({
      description: doc.value.fix_description,
      diff: doc.value.fix_diff
    }));
}
```

---

## Configuration Examples

### Basic Configuration

```typescript
import { createClient } from 'redis';

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redis.on('error', (err) => console.error('Redis error:', err));
await redis.connect();
```

### Redis Cloud Configuration

```typescript
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    tls: true,
    rejectUnauthorized: false
  }
});
```

---

## Common Commands

```bash
# Install dependencies
pnpm add redis openai uuid

# Start local Redis with vector support
docker run -d --name redis-stack -p 6379:6379 redis/redis-stack:latest

# Check Redis connection
redis-cli ping

# List all failure keys
redis-cli KEYS "failure:*"

# Check index info
redis-cli FT.INFO failure_idx
```

---

## Troubleshooting

### Issue: "Index not found" error

**Symptom:** Search fails with index error

**Solution:**
```typescript
// Always create index at startup
await createFailureIndex(redis);
```

### Issue: Embedding dimension mismatch

**Symptom:** "Vector dimension mismatch" error

**Solution:**
```typescript
// Ensure using text-embedding-3-small (1536 dim)
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',  // NOT text-embedding-3-large
  input: text
});
```

### Issue: No results returned

**Symptom:** Search returns empty array

**Solution:**
```typescript
// Check if data exists
const keys = await redis.keys('failure:*');
console.log('Failure count:', keys.length);

// Try broader search
const allResults = await redis.ft.search('failure_idx', '*');
```

---

## Cheat Sheet

| Task | Code |
|------|------|
| Connect | `await redis.connect()` |
| Store JSON | `await redis.json.set(key, '$', data)` |
| Get JSON | `await redis.json.get(key)` |
| Update field | `await redis.json.set(key, '$.field', value)` |
| KNN search | `await redis.ft.search(idx, '*=>[KNN K @vec $BLOB]')` |
| Text search | `await redis.ft.search(idx, '@field:text')` |
| Tag filter | `await redis.ft.search(idx, '@tag:{value}')` |
| Delete | `await redis.del(key)` |
| List keys | `await redis.keys('prefix:*')` |
