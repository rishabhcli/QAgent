'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Circle,
  Code2,
  FileSearch,
  Globe2,
  ListRestart,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  TestTube2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils/cn';

type StageId = 'test' | 'triage' | 'patch' | 'verify';
type EvidenceId = 'screenshot' | 'console' | 'network';
type PanelId = 'browser' | 'pipeline' | 'patch' | 'verify';
type StageStatus = 'failed' | 'diagnosing' | 'patching' | 'verified';

interface DemoStage {
  id: StageId;
  label: string;
  durationMs: number;
  holdMs: number;
  status: StageStatus;
  copy: {
    eyebrow: string;
    title: string;
    description: string;
    elapsed: string;
  };
  emphasis: PanelId;
  defaultEvidence: EvidenceId;
  icon: LucideIcon;
  accent: string;
  cursor: {
    x: number;
    y: number;
    label: string;
  };
}

interface DemoEvent {
  timestamp: string;
  target: PanelId;
  label: string;
  cue: string;
}

interface AutoplayState {
  playing: boolean;
  pausedByUser: boolean;
  pausedByHover: boolean;
  activeStage: StageId;
  stageStartedAt: number;
  stageElapsedMs: number;
}

interface EvidenceItem {
  id: EvidenceId;
  label: string;
  detail: string;
  icon: LucideIcon;
}

interface AnimatedRunDemoProps {
  replaySignal?: number;
}

const stageOrder: StageId[] = ['test', 'triage', 'patch', 'verify'];

const demoStages: DemoStage[] = [
  {
    id: 'test',
    label: 'Test',
    durationMs: 2400,
    holdMs: 400,
    status: 'failed',
    copy: {
      eyebrow: 'Browser test failed',
      title: 'Checkout regression detected',
      description:
        'QAgent drives the browser like a user, captures the failure, and pins every artifact to the run.',
      elapsed: '00:18',
    },
    emphasis: 'browser',
    defaultEvidence: 'screenshot',
    icon: TestTube2,
    accent:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300',
    cursor: { x: 24, y: 47, label: 'Submit checkout' },
  },
  {
    id: 'triage',
    label: 'Triage',
    durationMs: 2600,
    holdMs: 400,
    status: 'diagnosing',
    copy: {
      eyebrow: 'Root cause located',
      title: 'The payment route reads the body twice',
      description:
        'Logs, network traces, DOM state, and Redis memory converge on one unsafe server handler.',
      elapsed: '00:35',
    },
    emphasis: 'pipeline',
    defaultEvidence: 'console',
    icon: FileSearch,
    accent:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300',
    cursor: { x: 51, y: 34, label: 'Trace evidence' },
  },
  {
    id: 'patch',
    label: 'Patch',
    durationMs: 2800,
    holdMs: 500,
    status: 'patching',
    copy: {
      eyebrow: 'Patch generated',
      title: 'A minimal reviewable diff is ready',
      description:
        'The fixer changes only the request parsing path and keeps the PR tied to the original evidence.',
      elapsed: '01:07',
    },
    emphasis: 'patch',
    defaultEvidence: 'console',
    icon: Code2,
    accent:
      'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-blue-300',
    cursor: { x: 82, y: 34, label: 'Write patch' },
  },
  {
    id: 'verify',
    label: 'Verify',
    durationMs: 2200,
    holdMs: 2200,
    status: 'verified',
    copy: {
      eyebrow: 'Fix verified',
      title: 'Preview deployment passes the loop',
      description:
        'Verifier reruns browser, unit, integration, and regression checks before the fix is called ready.',
      elapsed: '03:21',
    },
    emphasis: 'verify',
    defaultEvidence: 'network',
    icon: ShieldCheck,
    accent:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300',
    cursor: { x: 85, y: 67, label: 'Confirm green' },
  },
];

const demoEvents: DemoEvent[] = [
  {
    timestamp: '00:18',
    target: 'browser',
    label: 'Failure captured',
    cue: 'Screenshot, DOM, console, and network traces are attached.',
  },
  {
    timestamp: '00:35',
    target: 'pipeline',
    label: 'Cause isolated',
    cue: 'The triage agent narrows the bug to one route handler.',
  },
  {
    timestamp: '01:07',
    target: 'patch',
    label: 'Diff prepared',
    cue: 'Patch lines reveal in the same order a reviewer would inspect them.',
  },
  {
    timestamp: '03:21',
    target: 'verify',
    label: 'Checks passed',
    cue: 'The checkout flow recovers and the fix pattern is saved.',
  },
];

const evidenceItems: EvidenceItem[] = [
  {
    id: 'screenshot',
    label: 'Screenshot',
    detail: 'Checkout shows payment failure after submit',
    icon: Monitor,
  },
  {
    id: 'console',
    label: 'Console error',
    detail: 'TypeError: body stream already read',
    icon: Terminal,
  },
  {
    id: 'network',
    label: 'Network log',
    detail: 'POST /api/charge recovered on preview',
    icon: Globe2,
  },
];

const metricsByStage: Record<StageId, Array<{ label: string; value: string; delta: string }>> = {
  test: [
    { label: 'Tests run', value: '142', delta: '+18 today' },
    { label: 'Failure rate', value: '1.4%', delta: 'spike found' },
    { label: 'Artifacts', value: '7', delta: 'captured' },
  ],
  triage: [
    { label: 'Trace match', value: '92%', delta: 'Redis hit' },
    { label: 'Files narrowed', value: '1', delta: 'route handler' },
    { label: 'Confidence', value: 'High', delta: '3 signals' },
  ],
  patch: [
    { label: 'Files changed', value: '1', delta: '+2 -1' },
    { label: 'PR status', value: 'Draft', delta: 'ready soon' },
    { label: 'Risk score', value: 'Low', delta: 'scoped diff' },
  ],
  verify: [
    { label: 'Checks passed', value: '44/44', delta: 'green' },
    { label: 'MTTR', value: '3m 21s', delta: '41% faster' },
    { label: 'Memory saved', value: '1', delta: 'reusable' },
  ],
};

const patchLines = [
  { kind: 'context', line: '36', text: 'export async function POST(req: Request) {' },
  { kind: 'removed', line: '37', text: '  const { amount } = req.json();' },
  { kind: 'added', line: '37', text: '  const body = await req.json();' },
  { kind: 'added', line: '38', text: '  const { amount } = body ?? {};' },
  { kind: 'context', line: '39', text: '  if (!amount) {' },
  {
    kind: 'context',
    line: '40',
    text: "    return NextResponse.json({ error: 'Amount required' }, { status: 400 });",
  },
  { kind: 'context', line: '41', text: '  }' },
];

const pipeline = [
  { label: 'Reproducing', detail: 'Running checkout scenario' },
  { label: 'Collecting evidence', detail: 'Logs, network, DOM' },
  { label: 'Triage', detail: 'Root cause identified' },
  { label: 'Patch generation', detail: 'Editing code' },
  { label: 'Applying patch', detail: 'Creating PR branch' },
  { label: 'Verifying fix', detail: 'Running tests' },
  { label: 'Completed', detail: 'All checks passed' },
];

function getStage(stageId: StageId) {
  return demoStages.find((stage) => stage.id === stageId) ?? demoStages[0];
}

function getStageIndex(stageId: StageId) {
  return stageOrder.indexOf(stageId);
}

function getNextStageId(stageId: StageId) {
  const index = getStageIndex(stageId);
  return stageOrder[(index + 1) % stageOrder.length];
}

export function AnimatedRunDemo({ replaySignal = 0 }: AnimatedRunDemoProps) {
  const reduceMotion = useReducedMotion();
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceId>('screenshot');
  const [progressMs, setProgressMs] = useState(0);
  const progressRef = useRef(0);
  const userInteractedRef = useRef(false);
  const [autoplay, setAutoplay] = useState<AutoplayState>({
    playing: false,
    pausedByUser: false,
    pausedByHover: false,
    activeStage: 'test',
    stageStartedAt: 0,
    stageElapsedMs: 0,
  });

  const currentStage = getStage(autoplay.activeStage);
  const currentStageIndex = getStageIndex(autoplay.activeStage);
  const activeEvent = demoEvents[currentStageIndex];
  const stageTotalMs = currentStage.durationMs + currentStage.holdMs;
  const progressPercent = reduceMotion
    ? currentStageIndex === stageOrder.length - 1
      ? 100
      : 0
    : Math.min(100, (progressMs / stageTotalMs) * 100);
  const isAutoplayActive = Boolean(!reduceMotion && autoplay.playing && !autoplay.pausedByHover);

  useEffect(() => {
    if (reduceMotion === true) {
      setAutoplay((state) => ({
        ...state,
        playing: false,
        pausedByUser: true,
        pausedByHover: false,
        stageStartedAt: 0,
        stageElapsedMs: 0,
      }));
      setProgressMs(0);
      progressRef.current = 0;
      return;
    }

    setAutoplay((state) => {
      if (state.playing || userInteractedRef.current) {
        return state;
      }

      return {
        ...state,
        playing: true,
        pausedByHover: false,
        stageStartedAt: Date.now(),
        stageElapsedMs: 0,
      };
    });
  }, [reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      return;
    }

    const nextStage = getStage('test');
    userInteractedRef.current = false;
    progressRef.current = 0;
    setProgressMs(0);
    setSelectedEvidence(nextStage.defaultEvidence);
    setAutoplay({
      playing: true,
      pausedByUser: false,
      pausedByHover: false,
      activeStage: nextStage.id,
      stageStartedAt: Date.now(),
      stageElapsedMs: 0,
    });
  }, [replaySignal, reduceMotion]);

  useEffect(() => {
    if (!isAutoplayActive) {
      return;
    }

    let frame = 0;

    const tick = () => {
      const elapsed = Date.now() - autoplay.stageStartedAt;
      const clamped = Math.min(elapsed, stageTotalMs);
      progressRef.current = clamped;
      setProgressMs(clamped);

      if (elapsed >= stageTotalMs) {
        const nextStageId = getNextStageId(autoplay.activeStage);
        const nextStage = getStage(nextStageId);
        progressRef.current = 0;
        setProgressMs(0);
        setSelectedEvidence(nextStage.defaultEvidence);
        setAutoplay((state) => ({
          ...state,
          activeStage: nextStageId,
          stageStartedAt: Date.now(),
          stageElapsedMs: 0,
        }));
        return;
      }

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [autoplay.activeStage, autoplay.stageStartedAt, isAutoplayActive, stageTotalMs]);

  const selectStage = (stageId: StageId, pauseByUser = true) => {
    const stage = getStage(stageId);
    userInteractedRef.current = pauseByUser;
    progressRef.current = 0;
    setProgressMs(0);
    setSelectedEvidence(stage.defaultEvidence);
    setAutoplay({
      playing: !pauseByUser && !reduceMotion,
      pausedByUser: pauseByUser || Boolean(reduceMotion),
      pausedByHover: false,
      activeStage: stageId,
      stageStartedAt: Date.now(),
      stageElapsedMs: 0,
    });
  };

  const restartDemo = () => {
    selectStage('test', Boolean(reduceMotion));
  };

  const toggleAutoplay = () => {
    if (reduceMotion) {
      userInteractedRef.current = true;
      selectStage(getNextStageId(autoplay.activeStage), true);
      return;
    }

    userInteractedRef.current = true;
    setAutoplay((state) => {
      const shouldResume = !state.playing || state.pausedByUser;
      const elapsed = progressRef.current;

      return {
        ...state,
        playing: shouldResume,
        pausedByUser: !shouldResume,
        pausedByHover: false,
        stageStartedAt: shouldResume ? Date.now() - elapsed : state.stageStartedAt,
        stageElapsedMs: elapsed,
      };
    });
  };

  const pauseTemporarily = () => {
    if (reduceMotion) {
      return;
    }

    const elapsed = progressRef.current;
    setAutoplay((state) => ({
      ...state,
      pausedByHover: true,
      stageElapsedMs: elapsed,
    }));
  };

  const resumeTemporaryPause = () => {
    if (reduceMotion) {
      return;
    }

    setAutoplay((state) => ({
      ...state,
      pausedByHover: false,
      stageStartedAt:
        state.playing && !state.pausedByUser
          ? Date.now() - state.stageElapsedMs
          : state.stageStartedAt,
    }));
  };

  const selectedEvidenceItem = useMemo(
    () => evidenceItems.find((item) => item.id === selectedEvidence) ?? evidenceItems[0],
    [selectedEvidence]
  );

  const emphasisClass = (panel: PanelId) =>
    cn(
      'min-w-0 rounded-[8px] border bg-white p-4 transition-colors dark:bg-slate-950',
      currentStage.emphasis === panel
        ? 'border-blue-300 ring-1 ring-blue-200 dark:border-blue-500/40 dark:ring-blue-500/20'
        : 'border-slate-200 dark:border-slate-800'
    );

  const panelMotion = (panel: PanelId) =>
    reduceMotion
      ? undefined
      : {
          scale: currentStage.emphasis === panel ? 1.012 : 1,
          y: currentStage.emphasis === panel ? -2 : 0,
          boxShadow:
            currentStage.emphasis === panel
              ? '0 22px 60px rgba(37, 99, 235, 0.16)'
              : '0 1px 2px rgba(15, 23, 42, 0.05)',
        };

  return (
    <motion.section
      id="product-demo"
      initial={reduceMotion ? undefined : { opacity: 0, y: 18, scale: 0.99 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      onMouseEnter={pauseTemporarily}
      onMouseLeave={resumeTemporaryPause}
      onFocusCapture={pauseTemporarily}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          resumeTemporaryPause();
        }
      }}
      className="relative min-w-0 overflow-hidden rounded-[8px] border border-slate-200 bg-slate-50 p-3 shadow-2xl shadow-slate-950/10 dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-black/30 lg:max-h-[calc(100svh-200px)] lg:overflow-y-auto"
      aria-label="Interactive QAgent demo"
    >
      <GhostCursor
        stage={currentStage}
        event={activeEvent}
        isVisible={Boolean(!reduceMotion)}
        isDimmed={!isAutoplayActive}
      />

      <div className="rounded-[8px] border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-4 dark:border-slate-800 xl:flex-row xl:items-center xl:justify-between">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {demoStages.map((stage, index) => {
              const Icon = stage.icon;
              const isActive = autoplay.activeStage === stage.id;
              const isComplete = index < currentStageIndex || currentStage.status === 'verified';
              const stageProgress = isComplete ? 100 : isActive ? progressPercent : 0;

              return (
                <button
                  key={stage.id}
                  type="button"
                  onClick={() => selectStage(stage.id)}
                  aria-pressed={isActive}
                  className={cn(
                    'group relative flex h-12 items-center justify-center gap-2 overflow-hidden rounded-[8px] border px-3 text-sm font-semibold transition',
                    isActive
                      ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-900'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-100 dark:bg-blue-950"
                  />
                  <motion.span
                    aria-hidden="true"
                    className="absolute bottom-0 left-0 h-0.5 bg-blue-600"
                    animate={{ width: `${stageProgress}%` }}
                    transition={{ duration: reduceMotion ? 0 : 0.25, ease: 'easeOut' }}
                  />
                  {isComplete ? (
                    <CheckCircle2 className="relative h-4 w-4 text-emerald-500" />
                  ) : (
                    <Icon className="relative h-4 w-4" />
                  )}
                  <span className="relative">{stage.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-200">Run #4821</span>
            <span className="inline-flex items-center gap-1 rounded-[8px] bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full bg-emerald-500',
                  isAutoplayActive && 'animate-pulse'
                )}
              />
              {isAutoplayActive ? 'Live' : 'Paused'}
            </span>
            <button
              type="button"
              onClick={toggleAutoplay}
              className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-3 font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {autoplay.playing && !autoplay.pausedByUser ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 fill-current" />
              )}
              {autoplay.playing && !autoplay.pausedByUser ? 'Pause demo' : 'Resume demo'}
            </button>
            <button
              type="button"
              onClick={restartDemo}
              className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-3 font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ListRestart className="h-4 w-4" />
              Restart
            </button>
          </div>
        </div>

        <ProgressRail
          currentStage={currentStage}
          currentStageIndex={currentStageIndex}
          progressPercent={progressPercent}
          isAutoplayActive={isAutoplayActive}
          reduceMotion={Boolean(reduceMotion)}
        />

        <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[0.33fr_0.34fr_0.33fr]">
          <motion.div
            animate={panelMotion('browser')}
            transition={{ type: 'spring', stiffness: 220, damping: 24 }}
          >
            <DemoEvidencePanel
              activeStage={autoplay.activeStage}
              currentStage={currentStage}
              selectedEvidence={selectedEvidence}
              selectedEvidenceItem={selectedEvidenceItem}
              onEvidenceChange={setSelectedEvidence}
              className={emphasisClass('browser')}
              reduceMotion={Boolean(reduceMotion)}
            />
          </motion.div>

          <motion.div
            animate={panelMotion('pipeline')}
            transition={{ type: 'spring', stiffness: 220, damping: 24 }}
          >
            <AgentPipeline
              activeStageIndex={currentStageIndex}
              className={emphasisClass('pipeline')}
              reduceMotion={Boolean(reduceMotion)}
            />
          </motion.div>

          <div className="grid min-w-0 gap-4">
            <motion.div
              animate={panelMotion('patch')}
              transition={{ type: 'spring', stiffness: 220, damping: 24 }}
            >
              <PatchPreview
                activeStageIndex={currentStageIndex}
                className={emphasisClass('patch')}
                reduceMotion={Boolean(reduceMotion)}
              />
            </motion.div>
            <motion.div
              animate={panelMotion('verify')}
              transition={{ type: 'spring', stiffness: 220, damping: 24 }}
            >
              <VerificationPanel
                activeStage={autoplay.activeStage}
                activeStageIndex={currentStageIndex}
                className={emphasisClass('verify')}
                reduceMotion={Boolean(reduceMotion)}
              />
            </motion.div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[0.58fr_0.42fr]">
          <RunTimeline
            currentStage={currentStage}
            currentStageIndex={currentStageIndex}
            progressPercent={progressPercent}
            onSelectStage={selectStage}
          />
          <MetricStrip activeStage={autoplay.activeStage} reduceMotion={Boolean(reduceMotion)} />
        </div>
      </div>
    </motion.section>
  );
}

function GhostCursor({
  stage,
  event,
  isVisible,
  isDimmed,
}: {
  stage: DemoStage;
  event: DemoEvent;
  isVisible: boolean;
  isDimmed: boolean;
}) {
  if (!isVisible) {
    return null;
  }

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute z-20 hidden items-start gap-2 lg:flex"
      animate={{
        left: `${stage.cursor.x}%`,
        top: `${stage.cursor.y}%`,
        opacity: isDimmed ? 0.55 : 1,
      }}
      transition={{ type: 'spring', stiffness: 80, damping: 18 }}
    >
      <div className="relative">
        <span className="absolute -left-3 -top-3 h-9 w-9 rounded-full border border-blue-300 bg-blue-500/10" />
        <Sparkles className="relative h-5 w-5 fill-blue-600 text-blue-600 drop-shadow-sm" />
      </div>
      <motion.div
        key={stage.id}
        initial={{ opacity: 0, y: 6, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.96 }}
        className="max-w-[190px] rounded-[8px] border border-blue-200 bg-white/95 px-3 py-2 text-xs shadow-xl shadow-blue-950/10 backdrop-blur dark:border-blue-500/30 dark:bg-slate-950/95"
      >
        <div className="font-semibold text-blue-700 dark:text-blue-300">{stage.cursor.label}</div>
        <div className="mt-0.5 text-slate-500 dark:text-slate-400">
          {event.timestamp} - {event.label}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ProgressRail({
  currentStage,
  currentStageIndex,
  progressPercent,
  isAutoplayActive,
  reduceMotion,
}: {
  currentStage: DemoStage;
  currentStageIndex: number;
  progressPercent: number;
  isAutoplayActive: boolean;
  reduceMotion: boolean;
}) {
  const ActiveIcon = currentStage.icon;
  const nextStage = getStage(getNextStageId(currentStage.id));

  return (
    <div className="mt-4 rounded-[8px] border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={currentStage.id}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            className="min-w-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-2 rounded-[8px] border px-2.5 py-1 text-xs font-semibold',
                  currentStage.accent
                )}
              >
                <ActiveIcon className="h-3.5 w-3.5" />
                {currentStage.copy.eyebrow}
              </span>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Next: {nextStage.label}
              </span>
            </div>
            <h3 className="mt-2 text-base font-semibold tracking-tight text-slate-950 dark:text-white">
              {currentStage.copy.title}
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
              {currentStage.copy.description}
            </p>
          </motion.div>
        </AnimatePresence>

        <div className="min-w-[210px]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>{isAutoplayActive ? 'Auto-playing run' : 'Run paused'}</span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <motion.div
              className="h-full rounded-full bg-blue-600"
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'linear' }}
            />
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2">
        {demoStages.map((stage, index) => {
          const isComplete = index < currentStageIndex || currentStage.status === 'verified';
          const isActive = stage.id === currentStage.id;
          const barWidth = isComplete ? 100 : isActive ? progressPercent : 0;

          return (
            <div key={stage.id}>
              <div className="h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <motion.div
                  className={cn(
                    'h-full rounded-full',
                    isComplete ? 'bg-emerald-500' : 'bg-blue-600'
                  )}
                  animate={{ width: `${barWidth}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.2 }}
                />
              </div>
              <div className="mt-1 truncate text-xs font-medium text-slate-500 dark:text-slate-400">
                {stage.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DemoEvidencePanel({
  activeStage,
  currentStage,
  selectedEvidence,
  selectedEvidenceItem,
  onEvidenceChange,
  className,
  reduceMotion,
}: {
  activeStage: StageId;
  currentStage: DemoStage;
  selectedEvidence: EvidenceId;
  selectedEvidenceItem: EvidenceItem;
  onEvidenceChange: (evidence: EvidenceId) => void;
  className?: string;
  reduceMotion: boolean;
}) {
  const EvidenceIcon = selectedEvidenceItem.icon;
  const recovered = activeStage === 'verify';

  return (
    <div className={className}>
      <div className="flex items-center justify-between">
        <div>
          <p
            className={cn(
              'text-sm font-semibold',
              recovered
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-red-600 dark:text-red-300'
            )}
          >
            1. Browser test {recovered ? '(Recovered)' : '(Failed)'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            https://acme.app/checkout
          </p>
        </div>
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {currentStage.copy.elapsed}
        </span>
      </div>

      <div className="mt-4 overflow-hidden rounded-[8px] border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <div className="ml-2 flex-1 rounded-[6px] border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            checkout
          </div>
        </div>
        <div className="p-4">
          <h3 className="text-xl font-semibold text-slate-950 dark:text-white">Checkout</h3>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={recovered ? 'payment-processed' : 'payment-failed'}
              initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.25 }}
              className={cn(
                'mt-4 rounded-[8px] border p-3',
                recovered
                  ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10'
                  : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10'
              )}
            >
              <div className="flex items-start gap-2">
                {recovered ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 text-red-600 dark:text-red-300" />
                )}
                <div>
                  <p className="text-sm font-semibold text-slate-950 dark:text-white">
                    {recovered ? 'Payment processed' : 'Payment failed'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    {recovered
                      ? 'Verification confirms the checkout flow recovers.'
                      : "We couldn't process your payment. Please try again."}
                  </p>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
          <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
            <span className="text-slate-600 dark:text-slate-300">Order summary</span>
            <span className="font-semibold text-slate-950 dark:text-white">$129.00</span>
          </div>
          <motion.button
            type="button"
            animate={
              reduceMotion ? undefined : { backgroundColor: recovered ? '#059669' : '#020617' }
            }
            className={cn(
              'mt-3 h-10 w-full rounded-[8px] text-sm font-semibold text-white',
              !recovered && 'dark:bg-slate-100 dark:text-slate-950'
            )}
          >
            Pay now
          </motion.button>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-950 dark:text-white">Evidence</p>
          <span className="rounded-[6px] bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            3
          </span>
        </div>
        <div className="mt-2 grid gap-2">
          {evidenceItems.map((item, index) => {
            const Icon = item.icon;
            const isSelected = item.id === selectedEvidence;

            return (
              <motion.button
                key={item.id}
                type="button"
                onClick={() => onEvidenceChange(item.id)}
                aria-pressed={isSelected}
                initial={reduceMotion ? false : { opacity: 0, x: -8 }}
                animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
                transition={{ duration: 0.22, delay: index * 0.06 }}
                className={cn(
                  'flex items-center gap-3 rounded-[8px] border p-2 text-left transition',
                  isSelected
                    ? 'border-blue-300 bg-blue-50 dark:border-blue-500/40 dark:bg-blue-500/10'
                    : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900'
                )}
              >
                <motion.span
                  animate={reduceMotion ? undefined : { scale: isSelected ? 1.06 : 1 }}
                  className="flex h-9 w-11 items-center justify-center rounded-[6px] bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300"
                >
                  <Icon className="h-4 w-4" />
                </motion.span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {item.label}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {item.detail}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 rounded-[8px] border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <EvidenceIcon className="h-3.5 w-3.5" />
          Selected evidence
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={selectedEvidenceItem.id}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
            className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200"
          >
            {selectedEvidenceItem.detail}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}

function AgentPipeline({
  activeStageIndex,
  className,
  reduceMotion,
}: {
  activeStageIndex: number;
  className?: string;
  reduceMotion: boolean;
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-950 dark:text-white">2. Agent pipeline</p>
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {demoStages[Math.min(activeStageIndex + 1, demoStages.length - 1)].copy.elapsed}
        </span>
      </div>

      <div className="mt-6 space-y-5">
        {pipeline.map((item, index) => {
          const threshold = activeStageIndex * 2;
          const isDone = index < threshold || activeStageIndex === stageOrder.length - 1;
          const isActive =
            index === threshold || (activeStageIndex === 3 && index === pipeline.length - 1);

          return (
            <motion.div
              key={item.label}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, x: -8 }}
              animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
              transition={{ duration: 0.18, delay: Math.min(index * 0.04, 0.22) }}
              className="relative flex gap-3"
            >
              {index < pipeline.length - 1 && (
                <span className="absolute left-[15px] top-8 h-8 w-px bg-slate-200 dark:bg-slate-800" />
              )}
              <motion.span
                animate={reduceMotion ? undefined : { scale: isActive ? 1.08 : 1 }}
                className={cn(
                  'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border bg-white dark:bg-slate-950',
                  isDone
                    ? 'border-emerald-500 bg-emerald-500 text-white dark:bg-emerald-500'
                    : isActive
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-slate-300 text-slate-300 dark:border-slate-700'
                )}
              >
                {isDone ? (
                  <Check className="h-4 w-4" />
                ) : isActive ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <Circle className="h-3 w-3" />
                )}
              </motion.span>
              <div>
                <p
                  className={cn(
                    'text-sm font-semibold',
                    isActive
                      ? 'text-blue-600 dark:text-blue-300'
                      : 'text-slate-800 dark:text-slate-100'
                  )}
                >
                  {item.label}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.detail}</p>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function PatchPreview({
  activeStageIndex,
  className,
  reduceMotion,
}: {
  activeStageIndex: number;
  className?: string;
  reduceMotion: boolean;
}) {
  const hasPatch = activeStageIndex >= 2;

  return (
    <div className={className}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-950 dark:text-white">3. Patch preview</p>
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">00:42</span>
      </div>
      <div className="mt-4 overflow-hidden rounded-[8px] border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
          <span className="font-mono text-slate-600 dark:text-slate-300">
            app/api/charge/route.ts
          </span>
          <span className="flex items-center gap-1">
            <span className="rounded-[6px] bg-red-50 px-1.5 py-0.5 font-mono text-red-600 dark:bg-red-500/10 dark:text-red-300">
              -1
            </span>
            <span className="rounded-[6px] bg-emerald-50 px-1.5 py-0.5 font-mono text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              +2
            </span>
          </span>
        </div>
        <div className="bg-white font-mono text-[11px] leading-6 dark:bg-slate-950 sm:text-xs">
          {patchLines.map((line, index) => (
            <motion.div
              key={`${line.line}-${line.text}`}
              initial={reduceMotion ? false : { opacity: 0.35, x: -6 }}
              animate={
                reduceMotion
                  ? undefined
                  : { opacity: hasPatch || line.kind === 'context' ? 1 : 0.45, x: 0 }
              }
              transition={{ duration: 0.18, delay: hasPatch ? index * 0.055 : 0 }}
              className={cn(
                'grid grid-cols-[36px_1fr] px-3',
                line.kind === 'removed' &&
                  'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
                line.kind === 'added' &&
                  'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200',
                line.kind === 'context' && 'text-slate-600 dark:text-slate-300'
              )}
            >
              <span className="select-none text-slate-400">{line.line}</span>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}
                {line.text}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="mt-3 inline-flex h-9 items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <Code2 className="h-4 w-4" />
        Open in editor
      </button>
    </div>
  );
}

function VerificationPanel({
  activeStage,
  activeStageIndex,
  className,
  reduceMotion,
}: {
  activeStage: StageId;
  activeStageIndex: number;
  className?: string;
  reduceMotion: boolean;
}) {
  const verification = [
    { label: 'Unit tests', detail: '18/18 passed', doneAt: 1 },
    { label: 'Integration tests', detail: '24/24 passed', doneAt: 2 },
    {
      label: 'E2E checkout flow',
      detail: activeStage === 'verify' ? 'Passed' : 'Running...',
      doneAt: 3,
    },
    {
      label: 'Regression suite',
      detail: activeStage === 'verify' ? 'Passed' : 'Pending',
      doneAt: 3,
    },
  ];

  return (
    <div className={className}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-950 dark:text-white">
          4. Verification{' '}
          <span className="font-normal text-slate-500 dark:text-slate-400">
            ({activeStage === 'verify' ? 'Passed' : 'In progress'})
          </span>
        </p>
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {activeStage === 'verify' ? '03:21' : '00:00'}
        </span>
      </div>

      <div className="mt-4 grid gap-3">
        {verification.map((item, index) => {
          const isDone = activeStageIndex >= item.doneAt;
          const isRunning = !isDone && index === 2;

          return (
            <motion.div
              key={item.label}
              layout={!reduceMotion}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <span className="text-slate-700 dark:text-slate-200">{item.label}</span>
              <span className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={`${item.label}-${item.detail}-${isDone}`}
                    initial={reduceMotion ? false : { opacity: 0, y: 5 }}
                    animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -5 }}
                    transition={{ duration: 0.16 }}
                  >
                    {item.detail}
                  </motion.span>
                </AnimatePresence>
                {isDone ? (
                  <motion.span
                    initial={reduceMotion ? false : { scale: 0.55 }}
                    animate={reduceMotion ? undefined : { scale: 1 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                  >
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  </motion.span>
                ) : isRunning ? (
                  <RefreshCw className="h-4 w-4 text-blue-600" />
                ) : (
                  <Circle className="h-4 w-4 text-slate-300 dark:text-slate-700" />
                )}
              </span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function RunTimeline({
  currentStage,
  currentStageIndex,
  progressPercent,
  onSelectStage,
}: {
  currentStage: DemoStage;
  currentStageIndex: number;
  progressPercent: number;
  onSelectStage: (stageId: StageId) => void;
}) {
  const ActiveIcon = currentStage.icon;

  return (
    <div className="rounded-[8px] border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-slate-950 dark:text-white">Run timeline</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Click any stage to pause and inspect it.
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-[8px] border px-2.5 py-1 text-xs font-semibold',
            currentStage.accent
          )}
        >
          <ActiveIcon className="h-3.5 w-3.5" />
          {currentStage.copy.eyebrow}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-4 gap-2">
        {demoStages.map((stage, index) => {
          const isComplete = index < currentStageIndex || currentStage.status === 'verified';
          const isActive = stage.id === currentStage.id;
          const fill = isComplete ? 100 : isActive ? progressPercent : 0;

          return (
            <button
              key={stage.id}
              type="button"
              onClick={() => onSelectStage(stage.id)}
              className="group min-w-0 text-left"
            >
              <div className="flex items-center">
                <span
                  className={cn(
                    'h-3 w-3 rounded-full border transition',
                    isComplete || isActive
                      ? 'border-blue-600 bg-blue-600'
                      : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950'
                  )}
                />
                <span className="mx-1 h-0.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <motion.span
                    className="block h-full rounded-full bg-blue-600"
                    animate={{ width: `${fill}%` }}
                    transition={{ duration: 0.16 }}
                  />
                </span>
              </div>
              <div className="mt-2 truncate text-xs font-semibold text-slate-700 group-hover:text-blue-600 dark:text-slate-200">
                {stage.label}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {index <= currentStageIndex ? stage.copy.elapsed : '-'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MetricStrip({
  activeStage,
  reduceMotion,
}: {
  activeStage: StageId;
  reduceMotion: boolean;
}) {
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-[8px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      {metricsByStage[activeStage].map((metric) => (
        <div
          key={metric.label}
          className="border-r border-slate-200 p-4 last:border-r-0 dark:border-slate-800"
        >
          <div className="text-xs text-slate-500 dark:text-slate-400">{metric.label}</div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${metric.label}-${metric.value}`}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="mt-2 text-xl font-semibold tracking-tight text-slate-950 dark:text-white"
            >
              {metric.value}
            </motion.div>
          </AnimatePresence>
          <div className="mt-1 text-xs font-medium text-emerald-600 dark:text-emerald-300">
            {metric.delta}
          </div>
        </div>
      ))}
    </div>
  );
}
