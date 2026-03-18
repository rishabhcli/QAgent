'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  CheckCircle2,
  Circle,
  Github,
  FolderGit2,
  TestTube2,
  Play,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SetupChecklistProps {
  isAuthenticated: boolean;
  hasSelectedRepo: boolean;
  hasTests: boolean;
  hasRuns: boolean;
  onDismiss: () => void;
}

interface Step {
  key: string;
  title: string;
  description: string;
  icon: React.ElementType;
  actionLabel: string;
  actionHref: string;
  completed: boolean;
}

/* ------------------------------------------------------------------ */
/*  Reduced-motion helper                                              */
/* ------------------------------------------------------------------ */

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ */
/*  SetupChecklist                                                     */
/* ------------------------------------------------------------------ */

export function SetupChecklist({
  isAuthenticated,
  hasSelectedRepo,
  hasTests,
  hasRuns,
  onDismiss,
}: SetupChecklistProps) {
  const prefersReducedMotion = useReducedMotion();

  const steps: Step[] = useMemo(
    () => [
      {
        key: 'github',
        title: 'Connect GitHub',
        description: 'Authenticate with GitHub so QAgent can access your repositories.',
        icon: Github,
        actionLabel: 'Connect GitHub',
        actionHref: '/api/auth/github',
        completed: isAuthenticated,
      },
      {
        key: 'repo',
        title: 'Select a repository',
        description: 'Choose which repo QAgent should test and patch.',
        icon: FolderGit2,
        actionLabel: 'Select repo',
        actionHref: '/dashboard/settings',
        completed: hasSelectedRepo,
      },
      {
        key: 'test',
        title: 'Create a test spec',
        description: 'Define at least one test so the agent knows what to verify.',
        icon: TestTube2,
        actionLabel: 'Create test',
        actionHref: '/dashboard/tests',
        completed: hasTests,
      },
      {
        key: 'run',
        title: 'Run your first pipeline',
        description: 'Kick off the test-fix-verify loop and watch QAgent work.',
        icon: Play,
        actionLabel: 'Start run',
        actionHref: '/dashboard/runs',
        completed: hasRuns,
      },
    ],
    [isAuthenticated, hasSelectedRepo, hasTests, hasRuns],
  );

  const completedCount = steps.filter((s) => s.completed).length;

  const motionProps = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, height: 0 },
        animate: { opacity: 1, height: 'auto' },
        exit: { opacity: 0, height: 0 },
        transition: { duration: 0.3, ease: 'easeInOut' as const },
      };

  return (
    <AnimatePresence>
      <motion.div {...motionProps} className="overflow-hidden">
        <div className="rounded-2xl border border-border/80 bg-card shadow-sm">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                Get started with QAgent
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {completedCount} of {steps.length} complete
              </p>
            </div>

            <button
              onClick={onDismiss}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="Dismiss setup checklist"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Progress bar */}
          <div className="mx-6 mb-4 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${(completedCount / steps.length) * 100}%` }}
            />
          </div>

          {/* Steps */}
          <ul className="divide-y divide-border/60 border-t border-border/60">
            {steps.map((step) => {
              const StepIcon = step.icon;

              return (
                <li
                  key={step.key}
                  className="flex items-center gap-4 px-6 py-4"
                >
                  {/* Status icon */}
                  {step.completed ? (
                    <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-primary" />
                  ) : (
                    <Circle className="h-5 w-5 flex-shrink-0 text-muted-foreground/50" />
                  )}

                  {/* Icon + text */}
                  <div
                    className={`flex flex-1 items-center gap-3 ${
                      step.completed ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="rounded-lg bg-primary/10 p-1.5">
                      <StepIcon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p
                        className={`text-sm font-medium ${
                          step.completed
                            ? 'text-muted-foreground line-through'
                            : 'text-foreground'
                        }`}
                      >
                        {step.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {step.description}
                      </p>
                    </div>
                  </div>

                  {/* Action */}
                  {!step.completed && (
                    <Link href={step.actionHref}>
                      <Button variant="outline" size="sm" className="gap-1.5 whitespace-nowrap">
                        {step.actionLabel}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/*  Backward-compatible wrapper                                        */
/*  Kept so that existing imports (e.g. dashboard layout) still work.  */
/*  Renders nothing — the checklist is now rendered inline on the       */
/*  dashboard page where it has access to the required data props.     */
/* ------------------------------------------------------------------ */

export function OnboardingWizard() {
  return null;
}
