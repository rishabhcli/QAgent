# CLAUDE.md - QAgent

This file is the **single source of truth** for AI agents working on this project. Read this file at the start of every session.

## Project Overview

**Project:** QAgent - Self-Healing QA Agent
**Description:** A self-improving QA agent that automatically tests web applications, identifies bugs, applies fixes to the app's code, and verifies the fixes – all without human intervention. It combines automated bug-finding and fixing in a closed-loop system that iterates until all tests pass.
**Status:** Active development and maintenance

### Why This Matters

- **Continuous Testing**: Constantly crawls and tests your web app like a QA engineer, simulating real user flows
- **Automatic Bug Fixing**: When it finds a failure, it reports it AND fixes the code, then redeploys
- **Self-Improvement**: Learns common failure patterns and fix strategies over time, reducing future bugs
- **Measurable Impact**: Track test pass rate, time-to-fix, iterations needed to demonstrate improvement

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Browser Automation | **Browserbase + Stagehand** | Run E2E tests in real browsers with AI-powered actions |
| Hosting/Deployment | **Vercel** | Host web app and instant deploy after fixes |
| Vector Memory | **Redis** | Store failure traces, fixes, and enable semantic lookup |
| Observability | **W&B Weave** | Trace agent runs, log metrics, evaluate improvements |
| Orchestration | **Custom Orchestrator (ADK/A2A-compatible)** | Multi-agent workflow coordination (ADK/A2A integration planned) |
| Dashboard | **Marimo** | Interactive analytics and live visualization |
| Demo App | **Next.js** | Target application for testing/fixing |
| LLM | **OpenAI / Gemini / Anthropic** | Patch generation and diagnosis |

---

## System Architecture

### Core Agents

1. **Tester Agent** - Generates and executes E2E tests using Browserbase/Stagehand
2. **Triage Agent** - Diagnoses failures, collects reproduction steps, queries knowledge base
3. **Fixer Agent** - Generates code patches using LLM + past fix patterns from Redis
4. **Verifier Agent** - Applies patches, redeploys via Vercel, re-runs tests
5. **Orchestrator** - Coordinates workflow via a custom, ADK/A2A-compatible orchestrator (integration planned)

### The QAgent Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                     QAGENT LOOP                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐ │
│   │  TESTER  │───▶│  TRIAGE  │───▶│  FIXER   │───▶│ VERIFIER │ │
│   │  Agent   │    │  Agent   │    │  Agent   │    │  Agent   │ │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘ │
│        │                                               │        │
│        │           ┌──────────────┐                    │        │
│        │           │    Redis     │                    │        │
│        │           │ (Knowledge   │◀───────────────────┘        │
│        │           │    Base)     │                             │
│        │           └──────────────┘                             │
│        │                  │                                     │
│        ▼                  ▼                                     │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                   W&B Weave (Logging)                   │  │
│   └─────────────────────────────────────────────────────────┘  │
│                            │                                    │
│                            ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                 Marimo Dashboard                         │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase Roadmap

### Phase 0: Planning & Setup
- [x] Define PRD and architecture
- [x] Set up project structure
- [x] Configure development environment
- [x] Initialize Next.js demo app with intentional bugs

### Phase 1: Test Environment (Browserbase + Stagehand)
- [x] Set up Browserbase account and API access
- [x] Integrate Stagehand SDK
- [x] Write 2-3 critical user flow tests
- [x] Implement Tester Agent with failure detection

### Phase 2: Core QAgent Loop
- [x] Implement Triage Agent (failure analysis)
- [x] Implement Fixer Agent (LLM patch generation)
- [x] Implement Verifier Agent (deploy + retest)
- [x] Create basic orchestration script

### Phase 3: Knowledge Base (Redis)
- [x] Set up Redis with vector search
- [x] Implement failure trace embedding
- [x] Create semantic lookup for similar issues
- [x] Store and retrieve fix patterns

### Phase 4: Logging & Dashboard (Weave + Marimo)
- [x] Integrate W&B Weave for tracing
- [x] Log all agent steps and metrics
- [x] Create Marimo dashboard
- [x] Visualize pass rate, time-to-fix, iterations

### Phase 5: TraceTriage & Self-Improvement
- [x] Implement trace analysis for agent failures
- [x] Auto-label failure causes (tool error, prompt drift, etc.)
- [x] A/B test workflow improvements
- [x] Refine prompts based on trace data

### Phase 6: RedTeam Integration
- [x] Create adversarial test suite
- [x] Add fuzzing for edge cases
- [x] Implement safety/jailbreak checks
- [x] Continuous regression for security

### Phase 7: Demo Preparation
- [x] End-to-end run validation
- [x] Record demo scenarios
- [x] Prepare 3-minute presentation
- [x] Document sponsor integrations

### Phase 8: Dashboard UI & GitHub OAuth
- [x] Build interactive dashboard UI
- [x] Implement GitHub OAuth authentication
- [x] Add MCP server configuration
- [x] Final integration testing

---

## Environment Variables

```bash
# Copy to .env.local and fill in values
cp .env.example .env.local
```

### Core Services

| Variable | Description | Required |
|----------|-------------|----------|
| `BROWSERBASE_API_KEY` | Browserbase API key for browser automation | Yes |
| `BROWSERBASE_PROJECT_ID` | Browserbase project identifier | Yes |
| `OPENAI_API_KEY` | OpenAI API key for LLM patch generation | Yes |
| `REDIS_URL` | Redis connection string with vector support | Yes |
| `VERCEL_TOKEN` | Vercel API token for deployments | Yes |
| `VERCEL_PROJECT_ID` | Vercel project identifier | Yes |
| `WANDB_API_KEY` | Weights & Biases API key for Weave | Yes |
| `GOOGLE_CLOUD_PROJECT` | Reserved for ADK/A2A integration (not required today) | No |
| `ANTHROPIC_API_KEY` | Anthropic API key (backup LLM) | No |

### GitHub Integration

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | GitHub token for code operations | Yes |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID | Yes |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret | Yes |
| `SESSION_SECRET` | Session encryption key (use `openssl rand -hex 32`) | Yes |

### MCP Server Integrations (Optional)

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | No |
| `SLACK_BOT_TOKEN` | Slack bot token for notifications | No |
| `LINEAR_API_KEY` | Linear API key for issue tracking | No |

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Run development server (demo app)
pnpm dev

# Run the QAgent agent
pnpm run agent

# Run tests manually
pnpm test

# Run E2E tests with Stagehand
pnpm run test:e2e

# Build for production
pnpm build

# Lint and format
pnpm lint && pnpm format

# Start Marimo dashboard
marimo run dashboard/app.py

# Deploy to Vercel
vercel deploy --prod
```

---

## Skills Directory

The `.claude/skills/` directory contains domain-specific knowledge modules:

| Skill | Purpose |
|-------|---------|
| `browserbase-stagehand/` | Browser automation, E2E testing, Stagehand SDK |
| `redis-vectorstore/` | Vector embeddings, semantic search, knowledge base |
| `vercel-deployment/` | Programmatic deployments, git integration |
| `wandb-weave/` | Tracing, evaluation, metrics logging |
| `google-adk/` | Reference patterns for planned ADK/A2A integration |
| `marimo-dashboards/` | Reactive notebooks, data visualization |
| `qagent-agents/` | Agent implementations, prompts, workflows |

---

## Ralph Loop Workflow

The agent follows the **Ralph Loop** cycle for iterative development:

1. **Read** - Load `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and relevant skills
2. **Analyze** - Understand current phase requirements
3. **Plan** - Break down into small, testable increments
4. **Execute** - Implement one increment at a time
5. **Validate** - Test, lint, verify acceptance criteria
6. **Loop** - Update tasks, commit, return to step 1

---

## Always / Never Rules

### Always
- Read CLAUDE.md at session start
- Write tests before marking tasks complete
- Commit working code with descriptive messages
- Keep secrets out of version control
- Follow the defined tech stack
- Log all agent actions to Weave
- Store failure patterns in Redis
- Verify fixes don't introduce regressions

### Never
- Skip testing
- Commit broken code
- Add dependencies without justification
- Ignore lint/type errors
- Hardcode secrets or credentials
- Deviate from phase scope without approval
- Deploy untested patches
- Ignore Redis lookup results
- Skip Weave logging for agent runs

---

## File Structure

```
QAgent/
├── .claude/
│   ├── settings.json
│   └── skills/
│       ├── browserbase-stagehand/
│       ├── redis-vectorstore/
│       ├── vercel-deployment/
│       ├── wandb-weave/
│       ├── google-adk/
│       ├── marimo-dashboards/
│       └── qagent-agents/
├── agents/
│   ├── tester/
│   ├── triage/
│   ├── fixer/
│   ├── verifier/
│   ├── orchestrator/
│   └── adk/                # ADK workflow & agents
├── app/
│   ├── api/                # Next.js API routes
│   │   ├── auth/           # GitHub OAuth endpoints
│   │   ├── runs/           # Pipeline run endpoints
│   │   ├── patches/        # Patch management
│   │   ├── monitoring/     # Monitoring configs
│   │   ├── learning/       # Learning metrics
│   │   ├── webhooks/       # GitHub webhooks
│   │   └── cron/           # Scheduled tasks
│   ├── dashboard/          # Dashboard UI pages
│   └── demo/               # Demo app (target for testing)
├── components/
│   ├── dashboard/          # Dashboard components
│   ├── diagnostics/        # Diagnostic views
│   ├── monitoring/         # Monitoring components
│   ├── patches/            # Patch management UI
│   ├── runs/               # Run tracking components
│   ├── ui/                 # Shared UI components
│   └── voice/              # Voice interface
├── dashboard/              # Marimo analytics dashboard
├── docs/
│   ├── PRD.md
│   ├── DESIGN.md
│   ├── ARCHITECTURE.md
│   ├── DEMO_SCRIPT.md
│   ├── PRE_DEMO_CHECKLIST.md
│   └── SPONSOR_INTEGRATIONS.md
├── lib/
│   ├── auth/               # Authentication utilities
│   ├── browserbase/        # Browser automation
│   ├── dashboard/          # Dashboard data helpers
│   ├── github/             # GitHub API integration
│   ├── hooks/              # React hooks
│   ├── llm/                # LLM providers
│   ├── queue/              # Job queue
│   ├── redis/              # Redis vector store
│   ├── redteam/            # Adversarial testing
│   ├── tracetriage/        # Trace analysis
│   ├── utils/              # Shared utilities
│   ├── vercel/             # Vercel deployment
│   ├── voice/              # Voice processing
│   └── weave/              # W&B Weave logging
├── mobile/                 # React Native mobile app
├── prompts/                # Agent prompts
├── scripts/                # Build/deploy scripts
├── tests/
│   ├── e2e/
│   └── unit/
├── AGENTS.md
├── CLAUDE.md
├── GEMINI.md
├── README.md
├── middleware.ts           # Next.js auth middleware
└── .env.example
```

---

## Current Focus

**Active Phase:** Active development and maintenance
**Blockers:** None

---

## References

- [QAgent Paper](https://arxiv.org/html/2502.02747v1) - Five-step agentic patching framework
- [Stagehand Docs](https://www.stagehand.dev/) - AI-powered browser automation
- [Browserbase Docs](https://docs.browserbase.com/) - Cloud browser infrastructure
- [Redis Vector Search](https://redis.io/docs/stack/search/reference/vectors/) - Semantic similarity
- [W&B Weave](https://wandb.ai/site/weave) - LLM observability
- [Google ADK](https://cloud.google.com/agent-development-kit) - Planned orchestration framework
- [Marimo](https://marimo.io/) - Reactive Python notebooks

---

*Last updated: March 2026*
