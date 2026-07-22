# Security Policy

## Supported Versions

QAgent is under active development. Security fixes are applied to the latest
released version and the `main` branch.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/rishabhcli/QAgent/security) of this repository.
2. Click **"Report a vulnerability"** to open a private advisory.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version(s) or commit
- Any suggested remediation

## What to Expect

- **Acknowledgement** within 5 business days.
- An assessment and, where accepted, a fix timeline communicated in the advisory.
- Credit for responsible disclosure once a fix is released, unless you prefer to remain anonymous.

## Scope & Handling of Secrets

QAgent orchestrates external services (Browserbase, OpenAI, Redis, Vercel, W&B).
Never commit real API keys or credentials. Use `.env.local` (git-ignored) and
the placeholders documented in [`.env.example`](./.env.example). If you discover
a leaked secret in the repository history, report it privately using the process
above so it can be rotated.
