# Contributing to QAgent

Thanks for your interest in contributing to **QAgent**, a self-healing QA agent that autonomously runs end-to-end tests, triages failures, generates fixes, redeploys, and learns from past bugs.

This guide explains how to set up the project, propose changes, and get them merged.

## Code of Conduct

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold it. Please report unacceptable behavior as described there.

## Ways to Contribute

- **Report bugs** using the [bug report template](./.github/ISSUE_TEMPLATE/bug_report.yml).
- **Request features** using the [feature request template](./.github/ISSUE_TEMPLATE/feature_request.yml).
- **Improve docs** – typos, clarifications, and examples are always welcome.
- **Submit code** – bug fixes, new agent capabilities, better retrieval/eval, and integrations.

If you plan a large change, please open an issue first so we can align on the approach before you invest time.

## Development Setup

**Prerequisites**

- [Node.js 20](./.nvmrc) (`nvm use` will pick it up)
- [pnpm](https://pnpm.io/) (`corepack enable` then `corepack prepare pnpm@latest --activate`)
- API keys for the services QAgent orchestrates (see [`.env.example`](./.env.example))

**Steps**

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/QAgent.git
cd QAgent

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env.local
# Fill in BROWSERBASE_API_KEY, OPENAI_API_KEY, REDIS_URL, VERCEL_TOKEN, WANDB_API_KEY, etc.

# 4. Run the demo app
pnpm dev

# 5. Run the agent loop
pnpm run agent
```

See the [README](./README.md) for the full architecture and [`docs/`](./docs) for the PRD, design, and architecture decision records.

## Development Workflow

1. Create a branch from `main`: `git checkout -b feat/short-description`.
2. Make your changes in small, focused commits.
3. Keep the tree green before pushing:

   ```bash
   pnpm lint          # eslint + tsc --noEmit
   pnpm format        # prettier --write
   pnpm test:run      # unit tests (vitest)
   pnpm run test:e2e  # end-to-end runner (optional, needs API keys)
   ```

4. Push your branch and open a Pull Request against `main`.

## Commit & PR Guidelines

- Use clear, descriptive commit messages. [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) are appreciated but not required.
- Reference related issues in the PR description (e.g. `Closes #123`).
- Fill out the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) and confirm the checklist.
- Keep PRs focused; unrelated changes should go in separate PRs.
- CI (lint, type-check, tests, CodeQL) must pass before review.

## Project Structure

```
agents/        # Tester, Triage, Fixer, Verifier, Orchestrator
app/           # Next.js demo application
dashboard/     # Marimo analytics dashboard
docs/          # PRD, DESIGN, ARCHITECTURE
lib/           # Shared libraries
prompts/       # Workflow prompts
tests/         # Unit + E2E suites
```

## License

By contributing, you agree that your contributions will be licensed under the project's [AGPL-3.0 License](./LICENSE).
