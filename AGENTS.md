# QAgent - AGENTS.md

> **AI Agent Guide**: This file is the primary reference for AI coding agents working on QAgent. Read this before starting any work.

---

## Project Overview

**QAgent** is a self-healing QA agent that automatically tests web applications, identifies bugs, applies fixes, and verifies the fixes – all without human intervention. It creates a closed-loop system that iterates until all tests pass.

### The QAgent Loop

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  TESTER  │───▶│  TRIAGE  │───▶│  FIXER   │───▶│ VERIFIER │
│  Agent   │    │  Agent   │    │  Agent   │    │  Agent   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │                                               │
     │           ┌──────────────┐                    │
     │           │    Redis     │◀───────────────────┘
     │           │ (Knowledge   │
     │           │    Base)     │
     │           └──────────────┘
     │                  │
     ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│              W&B Weave (Observability)                  │
└─────────────────────────────────────────────────────────┘
```

1. **Tester Agent** runs E2E tests using Browserbase + Stagehand
2. **Triage Agent** diagnoses failures and queries the knowledge base
3. **Fixer Agent** generates code patches using LLM + past fix patterns
4. **Verifier Agent** applies patches, deploys via Vercel, and re-runs tests
5. **Knowledge Base** (Redis) stores successful fixes for future reference

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | Next.js 14 (App Router), React 18, TypeScript | Demo app and dashboard UI |
| **Styling** | Tailwind CSS, Radix UI | Component styling and UI primitives |
| **Browser Automation** | Browserbase + Stagehand | AI-powered E2E testing |
| **Deployment** | Vercel | Instant deployment after fixes |
| **Vector Memory** | Redis Stack (with vector search) | Store failure traces and enable semantic lookup |
| **Observability** | W&B Weave | Trace agent runs, log metrics, evaluate improvements |
| **Dashboard** | Marimo | Interactive analytics and live visualization |
| **LLM** | OpenAI / Google Gemini / Anthropic | Patch generation and diagnosis |
| **Authentication** | GitHub OAuth | Dashboard access control |
| **Mobile** | React Native (Expo) | Mobile companion app |

---

## Project Structure

```
QAgent/
├── .claude/
│   └── skills/               # Domain-specific knowledge modules
│       ├── browserbase-stagehand/   # Browser automation patterns
│       ├── redis-vectorstore/       # Vector embeddings, semantic search
│       ├── vercel-deployment/       # Programmatic deployments
│       ├── wandb-weave/             # Tracing and evaluation
│       ├── google-adk/              # ADK/A2A integration patterns
│       ├── marimo-dashboards/       # Reactive notebooks
│       └── qagent-agents/           # Agent implementation patterns
├── agents/                   # Agent implementations
│   ├── analyzer/            # Run analysis and summarization
│   ├── crawler/             # Autonomous crawl and discovery flows
│   ├── tester/              # E2E test execution with Stagehand
│   ├── triage/              # Failure diagnosis and root cause analysis
│   ├── fixer/               # LLM-powered patch generation
│   ├── verifier/            # Patch application and deployment
│   ├── orchestrator/        # Workflow coordination (main entry point)
│   └── adk/                 # ADK workflow & agents (planned integration)
├── app/                     # Next.js App Router
│   ├── api/                 # API routes (auth, runs, patches, tests, webhooks)
│   ├── dashboard/           # Dashboard UI pages
│   └── layout.tsx           # App shell and metadata
├── components/              # React components
│   ├── dashboard/           # Dashboard-specific components
│   ├── diagnostics/         # Diagnostic views
│   ├── monitoring/          # Monitoring components
│   ├── onboarding/          # First-run guidance and setup
│   ├── patches/             # Patch management UI
│   ├── runs/                # Run tracking components
│   ├── ui/                  # Shared UI components (shadcn/ui style)
│   └── voice/               # Voice interface components
├── lib/                     # Shared libraries
│   ├── auth/                # Authentication utilities (GitHub OAuth)
│   ├── browserbase/         # Browser automation utilities
│   ├── dashboard/           # Dashboard data helpers
│   ├── git/                 # Local git workflow helpers
│   ├── github/              # GitHub API integration
│   ├── hooks/               # React hooks
│   ├── notifications/       # Toasts and notification helpers
│   ├── providers/           # React providers
│   ├── queue/               # Job queue processing
│   ├── redis/               # Redis vector store client
│   ├── redteam/             # Adversarial testing suite
│   ├── tracetriage/         # Trace analysis and self-improvement
│   ├── utils/               # Shared utilities
│   └── weave/               # W&B Weave logging and tracing
├── mobile/                  # React Native mobile app
├── dashboard/               # Marimo analytics dashboard (app.py)
├── docs/                    # Documentation
│   ├── PRD.md              # Product Requirements Document
│   ├── DESIGN.md           # System design and data structures
│   ├── ARCHITECTURE.md     # Architecture Decision Records
│   ├── DEMO_SCRIPT.md      # 3-minute demo script
│   └── SPONSOR_INTEGRATIONS.md  # Sponsor integration details
├── prompts/                 # Agent prompts
├── scripts/                 # Build/deploy helper scripts
├── tests/
│   ├── e2e/                # E2E test specs and runner
│   └── unit/               # Vitest unit tests
├── middleware.ts           # Next.js auth middleware
└── .env.example            # Environment variable template
```

---

## Build, Test, and Development Commands

```bash
# Install dependencies
pnpm install

# Development server (demo app)
pnpm dev                    # Starts Next.js dev server on localhost:3000

# Agent workflow
pnpm run agent              # Start the QAgent orchestrator

# Testing
pnpm test                   # Run unit tests with Vitest
pnpm run test:e2e           # Execute E2E flows via tests/e2e/runner.ts

# Code quality
pnpm lint                   # Run ESLint + TypeScript type-check
pnpm format                 # Format with Prettier
pnpm format:check           # Check formatting without modifying files

# Production
pnpm build                  # Build for production
pnpm start                  # Start production server

# Dashboard
pnpm dashboard              # Launch Marimo dashboard

# Redis
pnpm redis:init             # Initialize Redis schema
```

---

## Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | pnpm workspace configuration, scripts, dependencies |
| `tsconfig.json` | TypeScript compiler options (strict mode, path aliases) |
| `next.config.js` | Next.js configuration (React StrictMode) |
| `tailwind.config.js` | Tailwind CSS theme, colors, animations |
| `vitest.config.ts` | Vitest test configuration |
| `.eslintrc.json` | ESLint rules (extends next/core-web-vitals) |
| `.prettierrc` | Prettier formatting rules |
| `middleware.ts` | Next.js auth middleware (GitHub OAuth session validation) |

---

## Coding Style & Naming Conventions

- **Formatter**: Prettier is the source of truth
  - `tabWidth: 2`
  - `singleQuote: true`
  - `semi: true`
  - `trailingComma: es5`
  - `printWidth: 100`

- **TypeScript**: Strict mode enabled
  - Avoid `any` unless absolutely justified
  - Use explicit return types for public methods
  - Prefer interfaces over types for object shapes

- **Naming**:
  - PascalCase for components, classes, interfaces
  - camelCase for variables, functions, methods
  - UPPER_SNAKE_CASE for constants
  - kebab-case for file names

- **File Organization**:
  - One class per file for agents
  - Co-locate related types in `lib/types.ts`
  - Use path aliases (`@/`) for imports

---

## Testing Guidelines

### Unit Tests
- Location: `tests/unit/`
- Framework: Vitest
- Pattern: `*.test.ts`
- Run: `pnpm test`
- Coverage: Configured for `agents/**/*.ts` and `lib/**/*.ts`

### E2E Tests
- Location: `tests/e2e/`
- Test specs: `tests/e2e/specs.ts`
- Runner: `tests/e2e/runner.ts`
- Run: `pnpm run test:e2e`
- Framework: Stagehand (AI-powered browser automation)

## Environment Variables

Copy `.env.example` to `.env.local` and fill in required values:

### Required for Core Functionality
| Variable | Description |
|----------|-------------|
| `BROWSERBASE_API_KEY` | Browserbase API key for browser automation |
| `BROWSERBASE_PROJECT_ID` | Browserbase project identifier |
| `OPENAI_API_KEY` | OpenAI API key for LLM patch generation |
| `REDIS_URL` | Redis connection string (local or Redis Cloud) |
| `VERCEL_TOKEN` | Vercel API token for deployments |
| `VERCEL_PROJECT_ID` | Vercel project identifier |
| `WANDB_API_KEY` | Weights & Biases API key for Weave |

### Required for Dashboard
| Variable | Description |
|----------|-------------|
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `SESSION_SECRET` | Session encryption key (generate with `openssl rand -hex 32`) |

### Optional
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (backup LLM) |
| `GOOGLE_API_KEY` | Google API key for Gemini models |
| `GITHUB_TOKEN` | GitHub token for code operations |
| `DATABASE_URL` | PostgreSQL connection string |
| `SLACK_BOT_TOKEN` | Slack notifications |
| `LINEAR_API_KEY` | Linear issue tracking |

**Security Note**: Never commit `.env.local` to version control.

---

## Agent Architecture

### Tester Agent (`agents/tester/`)
- Executes E2E tests using Stagehand + Browserbase
- Captures screenshots, DOM snapshots, console logs on failure
- Generates structured `FailureReport` objects
- Instrumented with W&B Weave for observability

### Triage Agent (`agents/triage/`)
- Classifies failures: `UI_BUG`, `BACKEND_ERROR`, `DATA_ERROR`, `TEST_FLAKY`, `UNKNOWN`
- Localizes bugs to file/line using error patterns + LLM
- Queries Redis for similar past issues
- Generates `DiagnosisReport` with root cause analysis

### Fixer Agent (`agents/fixer/`)
- Generates minimal, targeted code patches
- Uses LLM with few-shot examples from knowledge base
- Validates patches for safety and syntax
- Produces unified diff format

### Verifier Agent (`agents/verifier/`)
- Applies patches to filesystem
- Creates backups and handles rollback
- Validates TypeScript/JSX syntax
- Deploys to Vercel and re-runs tests
- Records successful fixes in Redis

### Orchestrator (`agents/orchestrator/`)
- Coordinates the full QAgent loop
- Handles iteration limits and failure recovery
- Logs metrics to Weave
- Entry point: `pnpm run agent`

---

## Development Workflow (Ralph Loop)

Follow this iterative workflow for development:

1. **Read** - Load `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and relevant skills
2. **Analyze** - Understand current phase requirements
3. **Plan** - Break down into small, testable increments
4. **Execute** - Implement one increment at a time
5. **Validate** - Test, lint, verify acceptance criteria
6. **Loop** - Update documentation as needed, commit, and return to step 1

---

## Security & Safety Guidelines

### Always
- Keep secrets out of version control
- Validate all patches for dangerous patterns (`eval`, `exec`, `rm -rf`)
- Use parameterized queries for database access
- Sanitize user inputs in RedTeam tests
- Verify GitHub webhook signatures

### Never
- Hardcode secrets or credentials
- Deploy untested patches to production
- Skip Redis lookup results when available
- Ignore Weave logging for agent runs
- Commit broken code

---

## Key Files for AI Agents

| File | Purpose |
|------|---------|
| `AGENTS.md` | Primary repo guide for coding agents |
| `CLAUDE.md` | Detailed tech stack, phase roadmap, always/never rules |
| `GEMINI.md` | Compact project context for Gemini CLI |
| `lib/types.ts` | All TypeScript interfaces and types |
| `prompts/ralph-loop.md` | Development workflow prompts |
| `.claude/skills/` | Domain-specific implementation guides |

---

## Dependencies

### Production
- `next` - Next.js framework
- `@browserbasehq/stagehand` - AI browser automation
- `redis` - Redis client with vector search
- `weave` - W&B Weave observability
- `openai` - OpenAI SDK
- `@radix-ui/*` - Headless UI components
- `framer-motion` - Animations
- `recharts` - Charts for dashboard
- `lucide-react` - Icons

### Development
- `vitest` - Unit testing
- `typescript` - Type checking
- `eslint` - Linting
- `prettier` - Formatting
- `tsx` - TypeScript execution

---

## Troubleshooting

### Common Issues

**Stagehand initialization fails**
- Verify `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`
- Check Browserbase dashboard for session limits

**Redis connection errors**
- For local: ensure Redis Stack is running (`redis-server`)
- For cloud: verify `REDIS_URL` format

**TypeScript errors after patch**
- Fixer Agent may generate type-incorrect code
- Type errors are allowed; syntax errors are blocked
- Check `pnpm lint` output

**Vercel deployment fails**
- Verify `VERCEL_TOKEN` and `VERCEL_PROJECT_ID`
- Check git working directory is clean

---

## References

- [QAgent Paper](https://arxiv.org/html/2502.02747v1) - Five-step agentic patching framework
- [Stagehand Docs](https://www.stagehand.dev/) - AI-powered browser automation
- [Browserbase Docs](https://docs.browserbase.com/) - Cloud browser infrastructure
- [Redis Vector Search](https://redis.io/docs/stack/search/reference/vectors/) - Semantic similarity
- [W&B Weave](https://wandb.ai/site/weave) - LLM observability
- [Marimo](https://marimo.io/) - Reactive Python notebooks

---

*Last updated: March 2026*
