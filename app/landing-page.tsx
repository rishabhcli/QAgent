'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  Bot,
  CheckCircle2,
  Database,
  FileSearch,
  Github,
  GitPullRequest,
  Monitor,
  Play,
  Rocket,
  TestTube2,
} from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { AnimatedRunDemo } from '@/components/landing/animated-run-demo';

const GITHUB_REPO_URL = 'https://github.com/rishabhcli/QAgent';
const README_URL = `${GITHUB_REPO_URL}#readme`;

const loopSteps = [
  {
    id: 'test',
    title: 'Test like a user',
    description: 'Stagehand explores checkout, onboarding, settings, and other critical flows.',
    icon: TestTube2,
  },
  {
    id: 'triage',
    title: 'Diagnose with context',
    description: 'Screenshots, traces, DOM snapshots, and past fixes point to the likely source.',
    icon: FileSearch,
  },
  {
    id: 'patch',
    title: 'Write the smallest fix',
    description: 'The fixer produces a focused diff and attaches it to a GitHub pull request.',
    icon: GitPullRequest,
  },
  {
    id: 'verify',
    title: 'Prove it worked',
    description: 'Verifier deploys a preview, reruns tests, and stores the successful pattern.',
    icon: BadgeCheck,
  },
];

const integrations = [
  {
    name: 'Browserbase + Stagehand',
    description: 'Real browser execution with AI-native actions and evidence capture.',
    icon: Monitor,
  },
  {
    name: 'Redis vector memory',
    description: 'Similar failures and proven fixes become searchable engineering memory.',
    icon: Database,
  },
  {
    name: 'W&B Weave',
    description: 'Every agent decision, tool call, and outcome is traceable run by run.',
    icon: FileSearch,
  },
  {
    name: 'Vercel previews',
    description: 'Generated patches are verified against preview deployments before merge.',
    icon: Rocket,
  },
  {
    name: 'GitHub PRs',
    description: 'Teams review a concrete change with diagnosis, logs, and verification attached.',
    icon: Github,
  },
];

const authErrorMessages: Record<string, string> = {
  github_oauth_not_configured:
    'GitHub OAuth is not configured for local development. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env.local, then retry on localhost:3000.',
  oauth_failed: 'GitHub authentication failed. Please retry the connection flow.',
  invalid_state: 'GitHub authentication expired or lost state. Start the connection flow again.',
  no_code: 'GitHub did not return an authorization code. Retry the connection flow.',
};

export function LandingPage() {
  const reduceMotion = useReducedMotion();
  const searchParams = useSearchParams();
  const authError = searchParams.get('error');
  const authErrorMessage = authError ? authErrorMessages[authError] : null;
  const [demoReplaySignal, setDemoReplaySignal] = useState(0);

  const replayDemo = () => {
    setDemoReplaySignal((signal) => signal + 1);
    document
      .getElementById('product-demo')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="min-h-screen overflow-hidden bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <nav className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-85">
            <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-blue-600 text-white shadow-sm">
              <Bot className="h-5 w-5" />
            </div>
            <span className="text-xl font-semibold tracking-tight">QAgent</span>
          </Link>

          <div className="hidden items-center gap-8 text-sm font-medium text-slate-600 dark:text-slate-300 lg:flex">
            <a
              href="#product-demo"
              className="text-blue-600 hover:text-blue-700 dark:text-blue-300"
            >
              Product Demo
            </a>
            <a href="#loop" className="hover:text-slate-950 dark:hover:text-white">
              Loop
            </a>
            <a href="#integrations" className="hover:text-slate-950 dark:hover:text-white">
              Integrations
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-950 dark:hover:text-white"
            >
              GitHub
            </a>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden h-10 items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 sm:inline-flex"
              aria-label="View QAgent on GitHub"
            >
              <Github className="h-4 w-4" />
              12.4k
            </a>
            <a
              href="/api/auth/github"
              className="hidden h-10 items-center justify-center rounded-[8px] border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 sm:inline-flex"
            >
              Sign in
            </a>
            <a
              href="/api/auth/github"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
            >
              <Rocket className="h-4 w-4 sm:hidden" />
              <span className="hidden sm:inline">Start free trial</span>
              <span className="sm:hidden">Start</span>
            </a>
          </div>
        </div>
      </nav>

      <main>
        {authErrorMessage && (
          <section className="px-4 pt-6 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-[1440px]">
              <div
                className="flex items-start gap-3 rounded-[8px] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p>{authErrorMessage}</p>
              </div>
            </div>
          </section>
        )}

        <section className="relative border-b border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-950">
          <div className="mx-auto grid min-h-[calc(100svh-128px)] max-w-[1500px] items-start gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(420px,0.36fr)_minmax(0,0.64fr)] lg:px-8 lg:py-6">
            <div className="max-w-xl lg:pt-8">
              <motion.div
                initial={reduceMotion ? undefined : { opacity: 0, y: 12 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="inline-flex items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Self-healing QA agent
              </motion.div>

              <motion.h1
                initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: 0.05 }}
                className="mt-8 max-w-[560px] text-5xl font-semibold leading-[1.03] tracking-tight text-slate-950 dark:text-white sm:text-6xl lg:text-[60px]"
              >
                QAgent finds bugs, writes patches, and verifies fixes.
              </motion.h1>

              <motion.p
                initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: 0.1 }}
                className="mt-6 max-w-lg text-base leading-8 text-slate-600 dark:text-slate-300 sm:text-lg"
              >
                Autonomous end-to-end QA for modern web apps. QAgent tests your app, triages issues,
                writes patches, and verifies the fix so your team ships with confidence.
              </motion.p>

              <motion.div
                initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: 0.15 }}
                className="mt-8 flex flex-col gap-3 sm:flex-row"
              >
                <button
                  type="button"
                  onClick={replayDemo}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
                >
                  <Play className="h-4 w-4 fill-current" />
                  See how it works
                </button>
                <a
                  href={GITHUB_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-800"
                >
                  <Github className="h-4 w-4" />
                  Star on GitHub
                </a>
              </motion.div>

              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-3 text-sm text-slate-600 dark:text-slate-300">
                {['Real browser tests', 'Code-aware fixes', 'Self-healing loop'].map((item) => (
                  <span key={item} className="inline-flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <AnimatedRunDemo replaySignal={demoReplaySignal} />
          </div>
        </section>

        <section
          id="loop"
          className="border-b border-slate-200/80 bg-slate-50 px-4 pb-16 pt-8 dark:border-slate-800 dark:bg-slate-950 sm:px-6 lg:px-8"
        >
          <div className="mx-auto max-w-[1240px]">
            <div className="grid gap-8 lg:grid-cols-[0.36fr_0.64fr] lg:items-start">
              <div>
                <p className="text-sm font-semibold text-blue-600 dark:text-blue-300">The loop</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-4xl">
                  A closed QA cycle that stays reviewable.
                </h2>
                <p className="mt-4 text-sm leading-7 text-slate-600 dark:text-slate-300">
                  QAgent keeps browser evidence, diagnosis, code change, pull request, and
                  verification tied to the same run. The team sees exactly what changed and why.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {loopSteps.map((step, index) => (
                  <motion.article
                    key={step.title}
                    initial={reduceMotion ? undefined : { opacity: 0, y: 14 }}
                    whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.3 }}
                    transition={{ duration: 0.35, delay: index * 0.05 }}
                    className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
                        <step.icon className="h-5 w-5" />
                      </div>
                      <div className="text-xs font-semibold text-slate-400">0{index + 1}</div>
                    </div>
                    <h3 className="mt-4 text-base font-semibold text-slate-950 dark:text-white">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                      {step.description}
                    </p>
                  </motion.article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section
          id="integrations"
          className="bg-white px-4 py-16 dark:bg-slate-950 sm:px-6 lg:px-8"
        >
          <div className="mx-auto max-w-[1240px]">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-sm font-semibold text-blue-600 dark:text-blue-300">
                  Production integrations
                </p>
                <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-4xl">
                  Built around the tools teams already trust.
                </h2>
              </div>
              <a
                href={README_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 w-fit items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-800"
              >
                Documentation
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>

            <div className="mt-8 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
              {integrations.map((item) => (
                <article
                  key={item.name}
                  className="rounded-[8px] border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-slate-900/60"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-white text-blue-600 shadow-sm dark:bg-slate-950 dark:text-blue-300">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-slate-950 dark:text-white">
                    {item.name}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    {item.description}
                  </p>
                </article>
              ))}
            </div>

            <div className="mt-12 rounded-[8px] border border-slate-200 bg-slate-950 p-6 text-white shadow-sm dark:border-slate-800 sm:p-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-semibold text-blue-300">Ready for a real run?</p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                    Connect GitHub and let QAgent open its first verified fix.
                  </h2>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <a
                    href="/api/auth/github"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-500"
                  >
                    <Github className="h-4 w-4" />
                    Start free trial
                  </a>
                  <button
                    type="button"
                    onClick={replayDemo}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] border border-white/15 bg-white/10 px-4 text-sm font-semibold text-white transition hover:bg-white/15"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    Replay demo
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200/80 bg-white px-4 py-8 dark:border-slate-800 dark:bg-slate-950 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-4 text-sm text-slate-500 dark:text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <div>&copy; 2026 QAgent. Self-healing QA for real apps.</div>
          <div className="flex flex-wrap items-center gap-5">
            <a
              href={README_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-950 dark:hover:text-white"
            >
              Documentation
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-950 dark:hover:text-white"
            >
              Source
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
