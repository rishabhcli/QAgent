'use client';

import Link from 'next/link';
import {
  ArrowRight,
  BadgeCheck,
  Bug,
  Check,
  Github,
  Monitor,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';

const GITHUB_REPO_URL = 'https://github.com/rishabhcli/weavehacks';
const README_URL = `${GITHUB_REPO_URL}#readme`;
const DEMO_SCRIPT_URL = `${GITHUB_REPO_URL}/blob/main/docs/DEMO_SCRIPT.md`;
const STAGEHAND_URL = 'https://www.stagehand.dev/';
const REDIS_URL =
  'https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/search/';
const WANDB_URL = 'https://wandb.ai/site/weave';

const proofPoints = [
  { value: '4', label: 'Agents in the closed loop' },
  { value: '1', label: 'Run history across test, fix, verify' },
  { value: '0', label: 'Manual copy-paste between tools' },
];

const features = [
  {
    icon: Bug,
    title: 'Detect regressions from real user flows',
    description:
      'PatchPilot exercises the app the way a tester would, captures the failure context, and keeps the evidence attached to the run.',
  },
  {
    icon: Wand2,
    title: 'Generate targeted fixes, not rewrite guesses',
    description:
      'The triage and fixer stages narrow the scope before a patch is created, so the resulting diff stays understandable and reviewable.',
  },
  {
    icon: RefreshCw,
    title: 'Verify before anything is marked done',
    description:
      'Every patch flows back through validation so a fix only becomes real when it survives the next check.',
  },
];

const capabilities = [
  'Autonomous browser-based QA',
  'Patch creation with PR handoff',
  'Run history with diagnostics',
  'Knowledge reuse from prior fixes',
  'GitHub-connected workflow',
  'Observability through Weave',
];

const sponsorStack = [
  { name: 'W&B Weave', href: WANDB_URL, initials: 'WB' },
  { name: 'Redis', href: REDIS_URL, initials: 'RD' },
  { name: 'Stagehand', href: STAGEHAND_URL, initials: 'SH' },
  { name: 'Vercel', href: 'https://vercel.com/', initials: 'VC' },
];

const flowSteps = [
  {
    step: '01',
    title: 'Test',
    body: 'Run realistic browser checks against a target app or repo-backed environment.',
  },
  {
    step: '02',
    title: 'Diagnose',
    body: 'Classify the failure, inspect traces, and match against prior fixes when available.',
  },
  {
    step: '03',
    title: 'Patch',
    body: 'Create a minimal code change and hand it off as a GitHub pull request.',
  },
  {
    step: '04',
    title: 'Verify',
    body: 'Re-run validation and surface the outcome in one readable run history.',
  },
];

const motionCard = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45 },
};

export default function LandingPage() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="min-h-screen overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute left-[-10%] top-[-18%] h-80 w-80 rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute right-[-8%] top-[12%] h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute bottom-[-20%] left-[18%] h-96 w-96 rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.03),transparent_50%)] opacity-70" />
      </div>

      <nav className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-90">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
              <Zap className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-wide">PatchPilot</div>
              <div className="text-xs text-muted-foreground">Self-healing QA for real apps</div>
            </div>
          </Link>

          <div className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href={README_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">
              Documentation
            </a>
            <a
              href={DEMO_SCRIPT_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Demo script
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              GitHub
            </a>
          </div>

          <a
            href="/api/auth/github"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/25"
          >
            <Github className="h-4 w-4" />
            Connect GitHub
          </a>
        </div>
      </nav>

      <main>
        <section className="relative px-4 pb-12 pt-14 sm:px-6 sm:pt-20 lg:px-8">
          <div className="mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <motion.div
                {...motionCard}
                animate={reduceMotion ? undefined : motionCard.animate}
                className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-sm font-medium text-primary"
              >
                <Sparkles className="h-4 w-4" />
                Expressive automation for developer QA
              </motion.div>

              <motion.h1
                {...motionCard}
                animate={reduceMotion ? undefined : motionCard.animate}
                transition={{ duration: 0.5, delay: 0.05 }}
                className="mt-6 max-w-3xl text-5xl font-semibold tracking-tight sm:text-6xl lg:text-7xl"
              >
                Ship fixes faster with a QA loop that{' '}
                <span className="bg-gradient-to-r from-primary via-cyan-500 to-fuchsia-500 bg-clip-text text-transparent">
                  tests, patches, and verifies itself
                </span>
              </motion.h1>

              <motion.p
                {...motionCard}
                animate={reduceMotion ? undefined : motionCard.animate}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground"
              >
                PatchPilot runs browser checks, diagnoses failures, opens GitHub pull requests, and
                keeps the entire fix cycle in one reviewable workflow. It is designed for teams that
                need automation without sacrificing clarity.
              </motion.p>

              <motion.div
                {...motionCard}
                animate={reduceMotion ? undefined : motionCard.animate}
                transition={{ duration: 0.5, delay: 0.15 }}
                className="mt-8 flex flex-col gap-3 sm:flex-row"
              >
                <a
                  href="/api/auth/github"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/25"
                >
                  <Github className="h-4 w-4" />
                  Start with GitHub
                </a>
                <a
                  href={DEMO_SCRIPT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent"
                >
                  Read the demo script
                  <ArrowRight className="h-4 w-4" />
                </a>
              </motion.div>

              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                {proofPoints.map((item, index) => (
                  <motion.div
                    key={item.label}
                    initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
                    animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                    transition={{ duration: 0.45, delay: 0.2 + index * 0.08 }}
                    className="rounded-2xl border border-border/80 bg-card/80 p-4 shadow-sm backdrop-blur"
                  >
                    <div className="text-2xl font-semibold tracking-tight">{item.value}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{item.label}</div>
                  </motion.div>
                ))}
              </div>

              <div className="mt-8 flex flex-wrap gap-3 text-sm text-muted-foreground">
                {capabilities.map((capability) => (
                  <div
                    key={capability}
                    className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3 py-1.5"
                  >
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    <span>{capability}</span>
                  </div>
                ))}
              </div>
            </div>

            <motion.div
              initial={reduceMotion ? undefined : { opacity: 0, y: 24, scale: 0.98 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.55, delay: 0.15 }}
              className="relative"
            >
              <div className="absolute inset-0 -z-10 rounded-[2rem] bg-gradient-to-br from-primary/15 via-cyan-500/10 to-fuchsia-500/10 blur-2xl" />
              <div className="overflow-hidden rounded-[2rem] border border-border/80 bg-card/85 shadow-2xl shadow-primary/10 backdrop-blur-xl">
                <div className="border-b border-border/70 px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Run overview</p>
                      <p className="text-sm text-muted-foreground">
                        PatchPilot keeps the loop readable.
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-500">
                      <BadgeCheck className="h-3.5 w-3.5" />
                      Auto-merge ready
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 p-5 sm:p-6">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Monitor className="h-4 w-4 text-primary" />
                        Live browser test
                      </div>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        Capture failing browser context, keep screenshots attached, and move the
                        failure straight into triage.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Rocket className="h-4 w-4 text-primary" />
                        Pull request handoff
                      </div>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        Generated fixes are promoted into GitHub PRs so the team reviews a concrete
                        change instead of a vague recommendation.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium">PatchPilot loop</p>
                        <p className="text-sm text-muted-foreground">
                          Test, diagnose, patch, verify, and keep the run history in one place.
                        </p>
                      </div>
                      <div className="hidden items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary sm:inline-flex">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Verified workflow
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-4">
                      {flowSteps.map((step) => (
                        <div
                          key={step.step}
                          className="rounded-xl border border-border/70 bg-card p-3"
                        >
                          <div className="text-xs font-medium text-primary">{step.step}</div>
                          <div className="mt-1 text-sm font-medium">{step.title}</div>
                          <div className="mt-2 text-xs leading-5 text-muted-foreground">
                            {step.body}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Stage
                      </div>
                      <div className="mt-2 text-sm font-medium">Tester</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Finds regressions in real flows.
                      </div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Stage
                      </div>
                      <div className="mt-2 text-sm font-medium">Fixer</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Proposes the smallest useful patch.
                      </div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Stage
                      </div>
                      <div className="mt-2 text-sm font-medium">Verifier</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Confirms the change before it lands.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="px-4 py-10 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-6 lg:grid-cols-3">
              {features.map((feature, index) => (
                <motion.article
                  key={feature.title}
                  initial={reduceMotion ? undefined : { opacity: 0, y: 18 }}
                  animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, delay: 0.08 * index }}
                  className="rounded-[1.75rem] border border-border/80 bg-card/80 p-6 shadow-sm backdrop-blur"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <feature.icon className="h-5 w-5" />
                  </div>
                  <h2 className="mt-5 text-xl font-semibold tracking-tight">{feature.title}</h2>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    {feature.description}
                  </p>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr]">
              <div className="rounded-[2rem] border border-border/80 bg-muted/20 p-6 sm:p-8">
                <p className="text-sm font-medium text-primary">Why teams use it</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  A closed loop that stays reviewable from failure to merge
                </h2>
                <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground">
                  PatchPilot is built to reduce the gap between discovery and resolution. It keeps
                  the browser evidence, diagnosis, code change, PR, and verification tied to the
                  same run so the team can audit the full path.
                </p>
                <div className="mt-6 grid gap-3">
                  {[
                    'Browser evidence stays attached to the run.',
                    'Patch output is small enough to review quickly.',
                    'GitHub PRs make the change easy to discuss and merge.',
                    'Prior fixes can be reused instead of rediscovered.',
                  ].map((item) => (
                    <div
                      key={item}
                      className="flex items-start gap-3 rounded-2xl bg-background/70 p-4"
                    >
                      <Check className="mt-0.5 h-4 w-4 text-emerald-500" />
                      <p className="text-sm leading-6 text-foreground">{item}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {sponsorStack.map((sponsor, index) => (
                  <motion.a
                    key={sponsor.name}
                    href={sponsor.href}
                    target="_blank"
                    rel="noreferrer"
                    initial={reduceMotion ? undefined : { opacity: 0, y: 14 }}
                    animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.05 * index }}
                    className="group rounded-[1.5rem] border border-border/80 bg-card/80 p-5 shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-sm font-semibold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      {sponsor.initials}
                    </div>
                    <div className="mt-4 text-sm font-medium">{sponsor.name}</div>
                    <div className="mt-1 text-sm leading-6 text-muted-foreground">
                      Production infrastructure partner used in the PatchPilot workflow.
                    </div>
                  </motion.a>
                ))}

                <div className="sm:col-span-2 rounded-[1.5rem] border border-border/80 bg-gradient-to-br from-primary/10 via-background to-fuchsia-500/10 p-6 shadow-sm">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-primary">Built for real teams</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight">
                        Start with GitHub, end with a mergeable fix
                      </h3>
                    </div>
                    <a
                      href="/api/auth/github"
                      className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
                    >
                      <Github className="h-4 w-4" />
                      Connect GitHub
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="rounded-[2rem] border border-border/80 bg-card/85 p-6 sm:p-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-sm font-medium text-primary">Ready to use</p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                    A product page that matches the quality of the workflow behind it
                  </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
                    The entire public surface now speaks the same language as the app: expressive,
                    structured, and trustworthy.
                  </p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <a
                    href="/api/auth/github"
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
                  >
                    <Github className="h-4 w-4" />
                    Get started
                  </a>
                  <a
                    href={README_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium transition-all hover:border-primary/40 hover:bg-accent"
                  >
                    Documentation
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>Built for WeaveHacks 2026</div>
          <div className="flex flex-wrap items-center gap-5">
            <a href={README_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">
              Documentation
            </a>
            <a
              href={DEMO_SCRIPT_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Demo script
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              GitHub repository
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
