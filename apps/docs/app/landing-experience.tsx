'use client';

import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  Braces,
  Check,
  CheckCircle2,
  CircleDot,
  Database,
  GitBranch,
  GitFork,
  Monitor,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import patchMascot from './assets/patch-mascot.png';
import productRun from './assets/qagent-run.png';

const bugs = [
  {
    id: 'double',
    label: 'Double step',
    expression: 'value + 2',
    delta: 2,
    symptom: 'Expected 1, received 2',
    diagnosis: 'Increment applies the step twice.',
  },
  {
    id: 'frozen',
    label: 'Frozen state',
    expression: 'value + 0',
    delta: 0,
    symptom: 'Expected 1, received 0',
    diagnosis: 'The state update drops the increment.',
  },
  {
    id: 'reverse',
    label: 'Reverse step',
    expression: 'value - 1',
    delta: -1,
    symptom: 'Expected 1, received -1',
    diagnosis: 'The update moves in the wrong direction.',
  },
] as const;

type BugId = (typeof bugs)[number]['id'];
type RepairStage = 'idle' | 'test' | 'triage' | 'patch' | 'verify' | 'complete';
type InterfaceMode = 'desktop' | 'cli' | 'mcp';

const stageOrder: RepairStage[] = ['test', 'triage', 'patch', 'verify', 'complete'];
const stageLabels: Record<RepairStage, string> = {
  idle: 'Standing by',
  test: 'Reproducing',
  triage: 'Tracing cause',
  patch: 'Applying patch',
  verify: 'Verifying',
  complete: 'All green',
};

const stageTimeline = [
  { id: 'test' as const, label: 'Test', icon: CircleDot },
  { id: 'triage' as const, label: 'Triage', icon: ScanSearch },
  { id: 'patch' as const, label: 'Patch', icon: Wrench },
  { id: 'verify' as const, label: 'Verify', icon: ShieldCheck },
];

export function LandingExperience() {
  const [bugId, setBugId] = useState<BugId>('double');
  const [stage, setStage] = useState<RepairStage>('idle');
  const [repaired, setRepaired] = useState(false);
  const [count, setCount] = useState(0);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [interfaceMode, setInterfaceMode] = useState<InterfaceMode>('desktop');
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const bug = bugs.find((item) => item.id === bugId) ?? bugs[0];
  const stageIndex = stageOrder.indexOf(stage);
  const isRunning = stage !== 'idle' && stage !== 'complete';

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    []
  );

  function clearRun(): void {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }

  function resetDemo(nextBug: BugId = bugId): void {
    clearRun();
    setBugId(nextBug);
    setStage('idle');
    setRepaired(false);
    setCount(0);
    setHasInteracted(false);
  }

  function runRepair(): void {
    clearRun();
    setCount(0);
    setHasInteracted(false);
    setRepaired(false);
    setStage('test');
    for (const [index, nextStage] of (
      ['triage', 'patch', 'verify', 'complete'] as RepairStage[]
    ).entries()) {
      timers.current.push(
        setTimeout(
          () => {
            setStage(nextStage);
            if (nextStage === 'complete') setRepaired(true);
          },
          650 * (index + 1)
        )
      );
    }
  }

  function incrementCounter(): void {
    setCount((current) => current + (repaired ? 1 : bug.delta));
    setHasInteracted(true);
  }

  function focusLab(): void {
    document.querySelector<HTMLElement>('#try-qagent')?.focus();
    document.querySelector<HTMLElement>('#try-qagent')?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <main id="main-content" className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-circuit" aria-hidden="true">
          <span className="circuit circuit-one" />
          <span className="circuit circuit-two" />
          <span className="circuit circuit-three" />
          <span className="pixel pixel-one" />
          <span className="pixel pixel-two" />
          <span className="pixel pixel-three" />
        </div>
        <div className="hero-copy">
          <p className="hero-eyebrow">Open source / local first / evidence always</p>
          <h1 id="landing-title">QAgent</h1>
          <p className="hero-kicker">Find the bug. Patch the cause. Prove the fix.</p>
          <p className="hero-body">
            Autonomous QA for developers who want the repair and the receipts. QAgent works in an
            isolated Git worktree, verifies every change, and stops when repository policy says
            stop.
          </p>
          <div className="hero-actions">
            <button
              className="landing-button landing-button-primary"
              onClick={focusLab}
              type="button"
            >
              <Play size={17} fill="currentColor" aria-hidden="true" />
              Try the repair loop
            </button>
            <a
              className="landing-button landing-button-secondary"
              href="https://github.com/rishabhcli/QAgent"
            >
              <GitFork size={17} aria-hidden="true" />
              View source
            </a>
          </div>
          <ul className="hero-facts" aria-label="QAgent guarantees">
            <li>
              <GitBranch size={15} aria-hidden="true" />
              Active checkout untouched
            </li>
            <li>
              <Database size={15} aria-hidden="true" />
              Evidence survives restart
            </li>
            <li>
              <ShieldCheck size={15} aria-hidden="true" />
              Policy remains authoritative
            </li>
          </ul>
        </div>

        <div
          className={`hero-mascot mascot-${stage}`}
          aria-label={`Patch is ${stageLabels[stage]}`}
        >
          <span className="mascot-beacon" aria-hidden="true" />
          <Image
            className="mascot-image"
            src={patchMascot}
            alt="Patch, QAgent's pixel-art repair scout"
            priority
            sizes="(max-width: 760px) 230px, 420px"
          />
          <div className="mascot-readout" aria-live="polite">
            <span>PATCH / {stageLabels[stage]}</span>
            <span className="readout-blocks" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>

        <button className="hero-next" onClick={focusLab} type="button">
          Interactive fixture
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </section>

      <section className="lab-band" id="try-qagent" tabIndex={-1} aria-labelledby="lab-title">
        <div className="landing-width">
          <div className="section-heading section-heading-inverse">
            <p className="section-index">01 / Repair lab</p>
            <h2 id="lab-title">Break the counter. Let QAgent take it from there.</h2>
            <p>
              A browser-only walkthrough built from QAgent's real sample fixture. No repository,
              model, or provider call is made from this page.
            </p>
          </div>

          <div className={`repair-lab stage-${stage}`} data-testid="repair-lab" data-stage={stage}>
            <div className="lab-toolbar">
              <div className="lab-title-row">
                <span className="lab-window-mark" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>fixture/sample-counter</span>
              </div>
              <div className="lab-controls">
                <span className="fixture-label">Interactive fixture</span>
                <button
                  className="icon-control"
                  onClick={() => resetDemo()}
                  type="button"
                  title="Reset walkthrough"
                  aria-label="Reset walkthrough"
                >
                  <RotateCcw size={17} aria-hidden="true" />
                </button>
                <button
                  className="run-control"
                  onClick={runRepair}
                  type="button"
                  disabled={isRunning}
                >
                  {isRunning ? (
                    <ScanSearch size={17} aria-hidden="true" />
                  ) : (
                    <Play size={17} aria-hidden="true" />
                  )}
                  {isRunning
                    ? stageLabels[stage]
                    : stage === 'complete'
                      ? 'Run again'
                      : 'Run QAgent'}
                </button>
              </div>
            </div>

            <div className="recipe-bar">
              <span className="recipe-label">Defect recipe</span>
              <div className="recipe-segments" role="group" aria-label="Choose a defect recipe">
                {bugs.map((item) => (
                  <button
                    type="button"
                    aria-pressed={bugId === item.id}
                    className={bugId === item.id ? 'active' : ''}
                    key={item.id}
                    onClick={() => resetDemo(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="lab-grid">
              <section className="fixture-pane" aria-labelledby="fixture-title">
                <div className="pane-heading">
                  <span>
                    <Monitor size={16} aria-hidden="true" />
                    <strong id="fixture-title">Target app</strong>
                  </span>
                  <span className={`test-state ${resultState(repaired, hasInteracted)}`}>
                    {resultStateLabel(repaired, hasInteracted)}
                  </span>
                </div>
                <div className="fixture-browser">
                  <div className="browser-address">
                    <span aria-hidden="true" />
                    localhost:41773/counter
                  </div>
                  <div className="counter-demo">
                    <p>Counter</p>
                    <strong data-testid="fixture-count">{count}</strong>
                    <button onClick={incrementCounter} type="button" disabled={isRunning}>
                      Increment
                    </button>
                  </div>
                </div>
                <div className="fixture-assertion" aria-live="polite">
                  {hasInteracted ? (
                    repaired ? (
                      <>
                        <Check size={16} aria-hidden="true" /> Expected 1, received {count}
                      </>
                    ) : (
                      <>
                        <X size={16} aria-hidden="true" /> Expected 1, received {count}
                      </>
                    )
                  ) : (
                    <>
                      <CircleDot size={16} aria-hidden="true" /> Click Increment to reproduce the
                      check
                    </>
                  )}
                </div>
              </section>

              <section className="agent-pane" aria-labelledby="agent-title">
                <div className="pane-heading">
                  <span>
                    <SquareTerminal size={16} aria-hidden="true" />
                    <strong id="agent-title">Repair stream</strong>
                  </span>
                  <span className="stage-readout" aria-live="polite">
                    {stageLabels[stage]}
                  </span>
                </div>

                <ol className="repair-timeline" aria-label="Repair stages">
                  {stageTimeline.map((item) => {
                    const itemIndex = stageOrder.indexOf(item.id);
                    const active = stage === item.id;
                    const complete = stageIndex > itemIndex;
                    const Icon = item.icon;
                    return (
                      <li
                        className={active ? 'active' : complete ? 'complete' : ''}
                        key={item.id}
                        aria-current={active ? 'step' : undefined}
                      >
                        <span className="timeline-icon">
                          {complete ? (
                            <Check size={13} aria-hidden="true" />
                          ) : (
                            <Icon size={13} aria-hidden="true" />
                          )}
                        </span>
                        <span>
                          <strong>{item.label}</strong>
                          <small>{stageDetail(item.id, bug)}</small>
                        </span>
                      </li>
                    );
                  })}
                </ol>

                <div className={`patch-preview ${stageIndex >= 2 ? 'revealed' : ''}`}>
                  <div className="patch-heading">
                    <span>src/counter.mjs</span>
                    <span>{stageIndex >= 2 ? '1 file changed' : 'Awaiting grounded failure'}</span>
                  </div>
                  <pre aria-label="Generated repair diff">
                    <code>
                      <span className="diff-context"> export function increment(value) {'{'}</span>
                      <span className="diff-remove">- return {bug.expression};</span>
                      <span className="diff-add">+ return value + 1;</span>
                      <span className="diff-context"> {'}'}</span>
                    </code>
                  </pre>
                </div>
              </section>
            </div>

            <div className="lab-result" aria-live="polite">
              {stage === 'complete' ? (
                <>
                  <CheckCircle2 size={19} aria-hidden="true" />
                  <span>
                    <strong>Repair verified.</strong> The fixture now increments exactly once.
                  </span>
                </>
              ) : (
                <>
                  <CircleDot size={19} aria-hidden="true" />
                  <span>
                    <strong>{bug.symptom}.</strong> {bug.diagnosis}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="process-section" aria-labelledby="process-title">
        <div className="landing-width">
          <div className="section-heading">
            <p className="section-index">02 / The contract</p>
            <h2 id="process-title">One repair loop. No mystery steps.</h2>
          </div>
          <div className="process-rows">
            <article>
              <span>01</span>
              <GitBranch size={25} aria-hidden="true" />
              <h3>Isolate</h3>
              <p>A dedicated qagent branch and worktree keep the active checkout untouched.</p>
            </article>
            <article>
              <span>02</span>
              <ScanSearch size={25} aria-hidden="true" />
              <h3>Ground</h3>
              <p>Commands, screenshots, DOM, and logs become checksummed local evidence.</p>
            </article>
            <article>
              <span>03</span>
              <ShieldCheck size={25} aria-hidden="true" />
              <h3>Prove</h3>
              <p>Verification runs before publication, and repository policy controls the merge.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="evidence-section" aria-labelledby="evidence-title">
        <div className="landing-width evidence-layout">
          <div className="evidence-copy">
            <p className="section-index">03 / Product evidence</p>
            <h2 id="evidence-title">Receipts, not confetti.</h2>
            <p>
              Run detail keeps the stage timeline, screenshots, DOM, logs, patch, verification, and
              provider provenance together. Every value has a source and observation time.
            </p>
            <div className="evidence-key">
              <span>
                <i className="key-local" /> Local artifact
              </span>
              <span>
                <i className="key-provider" /> Provider output
              </span>
              <span>
                <i className="key-policy" /> Repository result
              </span>
            </div>
          </div>
          <figure className="product-shot">
            <div className="product-shot-frame">
              <Image
                src={productRun}
                alt="QAgent desktop run detail showing a completed repair, evidence artifacts, and activity timeline"
                sizes="(max-width: 760px) 100vw, 1100px"
              />
            </div>
            <figcaption>
              Real sample-fixture run / local Chromium / deterministic test model / July 22, 2026
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="interfaces-section" aria-labelledby="interfaces-title">
        <div className="landing-width">
          <div className="interface-heading">
            <div className="section-heading">
              <p className="section-index">04 / One engine</p>
              <h2 id="interfaces-title">Use the door that fits your work.</h2>
            </div>
            <div className="interface-tabs" role="tablist" aria-label="QAgent interfaces">
              {(['desktop', 'cli', 'mcp'] as InterfaceMode[]).map((mode) => (
                <button
                  id={`interface-tab-${mode}`}
                  type="button"
                  role="tab"
                  aria-selected={interfaceMode === mode}
                  aria-controls={`interface-panel-${mode}`}
                  className={interfaceMode === mode ? 'active' : ''}
                  onClick={() => setInterfaceMode(mode)}
                  key={mode}
                >
                  {mode === 'desktop' ? (
                    <Monitor size={16} aria-hidden="true" />
                  ) : mode === 'cli' ? (
                    <Terminal size={16} aria-hidden="true" />
                  ) : (
                    <Braces size={16} aria-hidden="true" />
                  )}
                  {mode === 'mcp' ? 'MCP' : titleCase(mode)}
                </button>
              ))}
            </div>
          </div>
          <InterfacePanel mode={interfaceMode} />
        </div>
      </section>

      <section className="landing-close" aria-labelledby="close-title">
        <div className="landing-width close-layout">
          <div>
            <p className="section-index">Local by default</p>
            <h2 id="close-title">Ready when your test isn't.</h2>
          </div>
          <div className="close-actions">
            <Link className="landing-button landing-button-light" href="/quickstart/">
              <SquareTerminal size={17} aria-hidden="true" />
              Read the quickstart
            </Link>
            <a
              className="landing-button landing-button-outline-light"
              href="https://github.com/rishabhcli/QAgent"
            >
              <GitFork size={17} aria-hidden="true" />
              Browse the source
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

function InterfacePanel({ mode }: { mode: InterfaceMode }) {
  const content = {
    desktop: {
      title: 'Guided when you want context.',
      body: 'Trust a repository, inspect the detected commands, connect a model, and follow evidence as the run advances.',
    },
    cli: {
      title: 'Scriptable when you want speed.',
      body: 'Human output, JSON, and NDJSON share the same durable run IDs and events used by the desktop app.',
    },
    mcp: {
      title: 'Constrained when an agent calls.',
      body: 'MCP can operate only on registered trusted projects and cannot expose secrets or arbitrary paths.',
    },
  }[mode];

  return (
    <div
      className="interface-panel"
      id={`interface-panel-${mode}`}
      role="tabpanel"
      aria-labelledby={`interface-tab-${mode}`}
      tabIndex={0}
    >
      <div className="interface-copy">
        <span className="interface-number">0{mode === 'desktop' ? 1 : mode === 'cli' ? 2 : 3}</span>
        <h3>{content.title}</h3>
        <p>{content.body}</p>
      </div>
      <div className={`interface-surface interface-${mode}`}>
        {mode === 'desktop' ? (
          <>
            <div className="mini-sidebar" aria-hidden="true">
              <span className="mini-logo">Q</span>
              <i />
              <i className="active" />
              <i />
            </div>
            <div className="mini-run">
              <span>RUN 2c98f31a</span>
              <strong>Repair verified on local branch.</strong>
              <div className="mini-stage-row" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <i className={index < 6 ? 'done' : ''} key={index} />
                ))}
              </div>
            </div>
          </>
        ) : mode === 'cli' ? (
          <pre tabIndex={0} aria-label="QAgent CLI example">
            <code>
              <span className="terminal-prompt">$</span> qagent run start project_42{`\n`}
              <span className="terminal-muted">run</span> 2c98f31a{`\n`}
              <span className="terminal-ok">ok</span> repair verified{`\n`}
              <span className="terminal-muted">branch</span> qagent/2c98f31a-counter
            </code>
          </pre>
        ) : (
          <div className="mcp-tools">
            <span>
              <Check size={14} aria-hidden="true" /> project_list
            </span>
            <span>
              <Check size={14} aria-hidden="true" /> run_start
            </span>
            <span>
              <Check size={14} aria-hidden="true" /> run_events
            </span>
            <span>
              <Check size={14} aria-hidden="true" /> artifact_read
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function stageDetail(stage: Exclude<RepairStage, 'idle' | 'complete'>, bug: (typeof bugs)[number]) {
  switch (stage) {
    case 'test':
      return bug.symptom;
    case 'triage':
      return bug.diagnosis;
    case 'patch':
      return 'One-line bounded diff';
    case 'verify':
      return 'Expected 1, received 1';
  }
}

function resultState(repaired: boolean, interacted: boolean): string {
  if (!interacted) return 'waiting';
  return repaired ? 'passing' : 'failing';
}

function resultStateLabel(repaired: boolean, interacted: boolean): string {
  if (!interacted) return 'Ready';
  return repaired ? 'Passing' : 'Failing';
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
