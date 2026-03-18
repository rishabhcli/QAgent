# QAgent Context for Gemini CLI

## Project Overview

**QAgent** is a self-healing QA agent system designed to automatically test web applications, identify bugs, apply fixes, and verify them without human intervention. It leverages a multi-agent architecture to create a closed-loop system for continuous quality assurance.

**Key Technologies:**
*   **Frontend/Demo App:** Next.js, Tailwind CSS, Vercel
*   **Agents:** TypeScript, Node.js, custom orchestrator (ADK/A2A-compatible; ADK planned)
*   **Browser Automation:** Browserbase, Stagehand (AI-powered)
*   **Data/Knowledge:** Redis (Vector Store for embeddings)
*   **AI/LLM:** OpenAI, Google Gemini, and Anthropic (patch generation and diagnosis)
*   **Observability:** W&B Weave (Tracing & Evaluation)
*   **Dashboard:** Marimo (Python-based reactive notebooks)

## Architecture

The system operates in a loop:
1.  **Tester Agent:** Runs E2E tests using natural language instructions via Stagehand on Browserbase.
2.  **Triage Agent:** Analyzes failures, stacks, and DOM states; queries Redis for similar past issues.
3.  **Fixer Agent:** Generates code patches using LLMs and historical fix data.
4.  **Verifier Agent:** Applies patches, triggers Vercel deployments, and re-runs tests.
5.  **Knowledge Base:** Successful fixes are embedded and stored in Redis to accelerate future fixes.

## Directory Structure

*   `agents/`: Source code for the specific agents (Tester, Triage, Fixer, Verifier) and the Orchestrator.
*   `app/`: The Next.js application that hosts the public landing page, dashboard, and API routes.
*   `dashboard/`: Marimo application (`app.py`) for visualizing agent performance and metrics.
*   `lib/`: Shared utilities, including clients for Redis, Browserbase, and Weave.
*   `docs/`: Extensive documentation including ADRs (`ARCHITECTURE.md`) and PRD (`PRD.md`).
*   `prompts/`: Markdown files containing system prompts and workflow guides (e.g., `ralph-loop.md`).
*   `scripts/`: Utility scripts such as Redis initialization (`init-redis.ts`).
*   `tests/`: Unit and E2E tests for the agents and the system itself.
*   `.claude/skills/`: Domain-specific knowledge modules for the AI assistant, including `qagent-agents/`.

## Operational Commands

### Setup & Dependencies
*   `pnpm install`: Install Node.js dependencies.
*   `cp .env.example .env.local`: Configure environment variables (Browserbase, OpenAI, Redis, Vercel, W&B).

### Running the System
*   **Demo App:** `pnpm dev` (Starts Next.js at localhost:3000)
*   **Agent Orchestrator:** `pnpm run agent` (Starts the QAgent agent loop)
*   **Dashboard:** `pnpm run dashboard` (Starts the Marimo dashboard)

### Testing & Maintenance
*   **E2E Tests:** `pnpm run test:e2e`
*   **Unit Tests:** `pnpm test` (Vitest)
*   **Linting:** `pnpm lint`
*   **Redis Init:** `pnpm run redis:init` (Initialize/Clear knowledge base)

## Development Conventions

*   **Package Manager:** Uses `pnpm`.
*   **Style:** TypeScript for agents/app, Python for dashboard. Follow existing patterns in `agents/` for new agent capabilities.
*   **Workflow:**
    *   Start with `AGENTS.md`, `CLAUDE.md`, and this file for current project context.
    *   Refer to `docs/ARCHITECTURE.md` when making structural changes.
    *   Use `prompts/ralph-loop.md` for the iterative development workflow.
*   **Observability:** All agent actions should be traced using Weave. Ensure new agent methods are wrapped with Weave decorators/loggers.

## Important Notes

*   **Sandboxing:** When running agents that modify code or execute shell commands, ensure appropriate safety boundaries are respected.
*   **Environment:** The system relies heavily on external APIs (Browserbase, OpenAI, Vercel). Ensure valid keys are present in `.env.local` for full functionality.
