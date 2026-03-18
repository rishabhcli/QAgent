# QAgent - Self-Healing QA Agent

A self-improving QA agent that automatically tests web applications, identifies bugs, applies fixes, and verifies the fixes – all without human intervention.

## Overview

QAgent is a multi-agent system that creates a closed-loop for automated bug detection and fixing:

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  TESTER  │───▶│  TRIAGE  │───▶│  FIXER   │───▶│ VERIFIER │
│  Agent   │    │  Agent   │    │  Agent   │    │  Agent   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │                                               │
     │              ┌──────────────┐                 │
     │              │    Redis     │◀────────────────┘
     │              │ (Knowledge   │
     │              │    Base)     │
     │              └──────────────┘
     │                    │
     ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│              W&B Weave (Observability)                  │
└─────────────────────────────────────────────────────────┘
```

### Why QAgent?

- **Continuous Testing**: Runs E2E tests like a QA engineer, simulating real user flows
- **Automatic Bug Fixing**: Doesn't just report bugs – it fixes them and redeploys
- **Self-Improvement**: Learns from past bugs to diagnose and fix faster over time
- **Measurable Impact**: Track pass rates, time-to-fix, and iterations to prove improvement

## Quick Start

```bash
# Clone the repository
git clone https://github.com/rishabhcli/QAgent.git
cd QAgent

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env.local
# Edit .env.local with your API keys

# Run development server (demo app)
pnpm dev

# Run the QAgent agent
pnpm run agent

# Start the Marimo dashboard
marimo run dashboard/app.py
```

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Browserbase + Stagehand** | AI-powered browser automation for E2E testing |
| **Vercel** | Instant deployment after fixes |
| **Redis** | Vector knowledge base for learning from past bugs |
| **W&B Weave** | Tracing and evaluation of agent runs |
| **Custom Orchestrator (ADK/A2A-compatible)** | Multi-agent workflow coordination (ADK integration planned) |
| **Marimo** | Interactive analytics dashboard |
| **Next.js** | Demo application |
| **OpenAI** | LLM for patch generation |

## Documentation

| File | Purpose |
|------|---------|
| [CLAUDE.md](./CLAUDE.md) | Agent configuration, tech stack, workflow rules |
| [TASKS.md](./TASKS.md) | Phase-scoped task tracker |
| [docs/PRD.md](./docs/PRD.md) | Product Requirements Document |
| [docs/DESIGN.md](./docs/DESIGN.md) | System design and data structures |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Architecture Decision Records |
| [prompts/ralph-loop.md](./prompts/ralph-loop.md) | Development workflow prompts |

## Project Structure

```
QAgent/
├── .claude/
│   └── skills/               # Domain-specific knowledge modules
│       ├── browserbase-stagehand/
│       ├── redis-vectorstore/
│       ├── vercel-deployment/
│       ├── wandb-weave/
│       ├── google-adk/
│       ├── marimo-dashboards/
│       └── qagent-agents/
├── agents/                   # Agent implementations
│   ├── tester/
│   ├── triage/
│   ├── fixer/
│   ├── verifier/
│   └── orchestrator/
├── app/                      # Next.js demo app
├── dashboard/                # Marimo analytics
├── docs/                     # Documentation
├── lib/                      # Shared libraries
├── prompts/                  # Workflow prompts
└── tests/                    # Test suites
```

## How It Works

### The QAgent Loop

1. **Test** - Tester Agent runs E2E tests using Browserbase/Stagehand
2. **Detect** - Failures are captured with screenshots, DOM state, logs
3. **Diagnose** - Triage Agent analyzes the failure and queries Redis for similar issues
4. **Fix** - Fixer Agent generates a patch using LLM + past fix patterns
5. **Deploy** - Verifier Agent applies the patch and deploys via Vercel
6. **Verify** - Tests are re-run to confirm the fix works
7. **Learn** - Successful fixes are stored in Redis for future reference
8. **Repeat** - Loop continues until all tests pass

### Self-Improvement

- **Knowledge Base**: Every bug and fix is stored with embeddings for semantic search
- **Pattern Learning**: Similar bugs are fixed faster using past solutions
- **TraceTriage**: Agent failures are analyzed to improve prompts and workflows
- **RedTeam**: Adversarial tests continuously harden the system

## For AI Agents

1. **Start every session** by reading [CLAUDE.md](./CLAUDE.md)
2. **Check current work** in [TASKS.md](./TASKS.md)
3. **Follow the Ralph Loop** workflow for iterative development
4. **Load skills** from `.claude/skills/` as needed

## Development

```bash
# Install dependencies
pnpm install

# Run demo app
pnpm dev

# Run agent
pnpm run agent

# Run tests
pnpm test

# Run E2E tests
pnpm run test:e2e

# Lint and format
pnpm lint && pnpm format

# Build
pnpm build
```

## Environment Variables

See [.env.example](./.env.example) for required environment variables:

- `BROWSERBASE_API_KEY` - Browserbase API key
- `OPENAI_API_KEY` - OpenAI API key
- `REDIS_URL` - Redis connection string
- `VERCEL_TOKEN` - Vercel API token
- `WANDB_API_KEY` - Weights & Biases API key
- `GOOGLE_CLOUD_PROJECT` - Google Cloud project (reserved for ADK/A2A integration)

## Getting Started

See the [Quick Start](#quick-start) section above for setup instructions. Once running, connect a GitHub repository through the dashboard and start your first QAgent run.

## References

- [QAgent Paper](https://arxiv.org/html/2502.02747v1) - Agentic patching framework
- [Stagehand](https://www.stagehand.dev/) - AI browser automation
- [Browserbase](https://browserbase.com/) - Cloud browsers
- [W&B Weave](https://wandb.ai/site/weave) - LLM observability
- [Google ADK](https://cloud.google.com/agent-development-kit) - Planned orchestration framework
- [Marimo](https://marimo.io/) - Reactive notebooks

## License

[See LICENSE file](./LICENSE)
