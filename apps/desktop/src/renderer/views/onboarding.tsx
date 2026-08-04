import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandSpec, CorrectiveAction, DoctorReport, Project } from '@qagent/contracts';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Globe2,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { formatCommand } from '../command-format.js';
import { AgentPresence, type AgentPresenceMode } from '../components/agent-presence.js';
import { DoctorChecks } from '../components/doctor-checks.js';
import { StatusPill } from '../components/status-pill.js';
import type { DetectedProjectData } from '../types.js';

type Provider = 'openai' | 'anthropic' | 'google' | 'openai-compatible';
type BrowserProvider = 'local' | 'browserbase';
type BusyAction = 'inspect' | 'trust' | 'configure' | 'browser' | 'launch';

export function Onboarding({
  onComplete,
  onCancel,
  initialProject,
}: {
  onComplete: (project: Project, startRun: boolean) => Promise<void>;
  onCancel?: () => void;
  initialProject?: Project | null;
}) {
  const [step, setStep] = useState(0);
  const [detected, setDetected] = useState<DetectedProjectData | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [credential, setCredential] = useState('');
  const [browserProvider, setBrowserProvider] = useState<BrowserProvider>('local');
  const [browserbaseKey, setBrowserbaseKey] = useState('');
  const [browserbaseProjectId, setBrowserbaseProjectId] = useState('');
  const [browserbaseConfigured, setBrowserbaseConfigured] = useState(false);
  const [publish, setPublish] = useState<'github' | 'local'>('github');
  const [githubToken, setGithubToken] = useState('');
  const [weaveEnabled, setWeaveEnabled] = useState(false);
  const [weaveAccepted, setWeaveAccepted] = useState(false);
  const [weaveKey, setWeaveKey] = useState('');
  const [weaveConfigured, setWeaveConfigured] = useState(false);
  const [testExecutable, setTestExecutable] = useState('');
  const [testArgs, setTestArgs] = useState('');
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserProgress, setBrowserProgress] = useState<number | null>(null);
  const setupContentRef = useRef<HTMLElement>(null);
  const busy = busyAction !== null;
  const applyInspection = useCallback((inspected: DetectedProjectData) => {
    setDetected(inspected);
    if (!inspected.config) return;
    setProvider(inspected.config.model.provider);
    setModel(inspected.config.model.model);
    setBaseUrl(inspected.config.model.baseUrl ?? 'http://127.0.0.1:11434/v1');
    setBrowserProvider(inspected.config.browser.provider);
    setPublish(inspected.config.publish.provider);
    setWeaveEnabled(inspected.config.telemetry.weave.enabled);
  }, []);

  useEffect(
    () =>
      window.qagent.onEvent((event) => {
        if (event.type !== 'browser.progress') return;
        const progress = event.data as { downloadedBytes: number; totalBytes: number };
        setBrowserProgress(
          progress.totalBytes > 0
            ? Math.round((progress.downloadedBytes / progress.totalBytes) * 100)
            : 0
        );
      }),
    []
  );

  useEffect(() => {
    void Promise.all([desktopApi.credentialStatuses(), desktopApi.getPreferences()])
      .then(([statuses, preferences]) => {
        setWeaveConfigured(
          statuses.some((status) => status.provider === 'weave' && status.configured)
        );
        setBrowserbaseConfigured(
          statuses.some((status) => status.provider === 'browserbase' && status.configured)
        );
        setBrowserbaseProjectId(preferences.browserbaseProjectId);
      })
      .catch(() => {
        setWeaveConfigured(false);
        setBrowserbaseConfigured(false);
      });
  }, []);

  useEffect(() => {
    if (!initialProject) return;
    let current = true;
    setBusyAction('inspect');
    setError(null);
    void desktopApi
      .inspectProject(initialProject.path, initialProject.configPath)
      .then((inspected) => {
        if (!current) return;
        applyInspection(inspected);
        setProject(initialProject);
        setTrusted(initialProject.trusted);
        setStep(2);
      })
      .catch((caught) => {
        if (current) setError(message(caught));
      })
      .finally(() => {
        if (current) setBusyAction(null);
      });
    return () => {
      current = false;
    };
  }, [applyInspection, initialProject]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setupContentRef.current?.querySelector<HTMLElement>('h1')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  async function chooseProject() {
    setError(null);
    const path = await desktopApi.selectDirectory();
    if (!path) return;
    setBusyAction('inspect');
    try {
      const inspected = await desktopApi.inspectProject(path);
      applyInspection(inspected);
      setStep(1);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusyAction(null);
    }
  }

  async function registerProject() {
    if (!detected || !trusted) return;
    await runBusy('trust', async () => {
      setProject(await desktopApi.addProject(detected.path, true));
      setStep(2);
    });
  }

  async function configureProject() {
    if (!project || !model || (detected?.suggestedTestCommands.length === 0 && !testExecutable)) {
      setError('Model and test command are required.');
      return;
    }
    await runBusy('configure', async () => {
      if (provider !== 'openai-compatible' && credential) {
        await desktopApi.setCredential(provider, credential, { deferRestart: true });
      }
      if (publish === 'github' && githubToken)
        await desktopApi.setCredential('github', githubToken, { deferRestart: true });
      if (browserProvider === 'browserbase' && browserbaseKey) {
        await desktopApi.setCredential('browserbase', browserbaseKey, { deferRestart: true });
      }
      if (weaveEnabled && weaveKey)
        await desktopApi.setCredential('weave', weaveKey, { deferRestart: true });
      await desktopApi.setPreferences({
        weaveEnabled,
        weaveDisclosureAccepted: weaveEnabled && weaveAccepted,
        browserbaseProjectId,
      });
      const configuredProject = await desktopApi.configureProject({
        projectId: project.id,
        provider,
        model,
        baseUrl: provider === 'openai-compatible' ? baseUrl : undefined,
        browserProvider,
        publish,
        weaveEnabled,
        testExecutable: testExecutable || undefined,
        testArgs: testArgs.split(/\s+/).filter(Boolean),
      });
      setProject(configuredProject);
      setDoctor(await desktopApi.doctor(configuredProject.id));
      setStep(3);
    });
  }

  async function installBrowser() {
    setBrowserProgress(0);
    await runBusy('browser', async () => {
      await desktopApi.installBrowser();
      if (project) setDoctor(await desktopApi.doctor(project.id));
    });
    setBrowserProgress(null);
  }

  async function applyDoctorAction(action: CorrectiveAction) {
    if (action.type === 'command') return;
    if (action.type === 'external') {
      await runBusy('configure', () => desktopApi.openExternal(action.url));
      return;
    }
    if (action.type === 'application') {
      if (action.action === 'install_browser') {
        await installBrowser();
        return;
      }
      if (
        action.action === 'configure_project' ||
        action.action === 'configure_provider' ||
        action.action === 'review_policy'
      ) {
        setStep(2);
        return;
      }
      if (action.action === 'rerun_doctor' && project) {
        await runBusy('configure', async () => setDoctor(await desktopApi.doctor(project.id)));
      }
    }
  }

  async function finishOnboarding(startRun: boolean) {
    if (!project) return;
    await runBusy('launch', () => onComplete(project, startRun));
  }

  async function runBusy(actionName: BusyAction, action: () => Promise<void>) {
    setBusyAction(actionName);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusyAction(null);
    }
  }

  const signal = onboardingSignal({
    step,
    busyAction,
    detected,
    doctor,
    provider,
    publish,
    browserProgress,
  });

  return (
    <main className="onboarding-shell" data-step={step} data-busy={busyAction ?? 'idle'}>
      <div className="onboarding-topbar">
        <div className="brand onboarding-brand">
          <span className="brand-mark">
            <span>Q</span>
            <i aria-hidden="true" />
          </span>
          <span className="brand-lockup">
            <span className="brand-name">QAgent</span>
            <small>First run</small>
          </span>
        </div>
        <div className="onboarding-topbar-actions">
          <span className="step-count" aria-live="polite">
            <strong>0{step + 1}</strong>
            <span>of 04</span>
          </span>
          {onCancel && (
            <button
              className="onboarding-close"
              type="button"
              aria-label="Close setup"
              onClick={onCancel}
            >
              <X size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="onboarding-progress" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={index <= step ? 'active' : ''}>
            <i />
          </span>
        ))}
      </div>
      <div className="onboarding-layout">
        <ol className="setup-rail" aria-label="Setup progress">
          {['Repository', 'Trust', 'Model', 'Doctor'].map((label, index) => (
            <li
              key={label}
              className={index === step ? 'current' : index < step ? 'done' : ''}
              aria-current={index === step ? 'step' : undefined}
            >
              <span>{index < step ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
              <span className="setup-rail-label">{label}</span>
            </li>
          ))}
        </ol>
        <section className="setup-content" key={step} ref={setupContentRef}>
          {step === 0 && (
            <>
              <span className="section-icon">
                <FolderOpen size={22} aria-hidden="true" />
              </span>
              <p className="eyebrow">Start</p>
              <h1 tabIndex={-1}>Choose a repository.</h1>
              <p className="setup-lede">Inspection stays local. Repairs use a separate worktree.</p>
              <button className="button primary" onClick={chooseProject} disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={17} aria-hidden="true" />
                ) : (
                  <FolderOpen size={17} aria-hidden="true" />
                )}
                Choose folder
              </button>
            </>
          )}
          {step === 1 && detected && (
            <>
              <span className="section-icon">
                <ShieldCheck size={22} aria-hidden="true" />
              </span>
              <p className="eyebrow">Trust</p>
              <h1 tabIndex={-1}>{detected.name}</h1>
              <dl className="repository-facts">
                <div>
                  <dt>Canonical path</dt>
                  <dd title={detected.trustPreview.canonicalPath}>
                    {detected.trustPreview.canonicalPath}
                  </dd>
                </div>
                {detected.trustPreview.requestedPath !== detected.trustPreview.canonicalPath && (
                  <div>
                    <dt>Selected path</dt>
                    <dd title={detected.trustPreview.requestedPath}>
                      {detected.trustPreview.requestedPath}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Stack</dt>
                  <dd>{detected.stack}</dd>
                </div>
              </dl>
              {detected.suggestedTestCommands.length === 0 && (
                <div className="field-grid two">
                  <label>
                    Test executable
                    <input
                      value={testExecutable}
                      onChange={(event) => setTestExecutable(event.target.value)}
                      placeholder="e.g. pytest"
                    />
                  </label>
                  <label>
                    Arguments
                    <input
                      value={testArgs}
                      onChange={(event) => setTestArgs(event.target.value)}
                      placeholder="e.g. -q tests"
                    />
                  </label>
                </div>
              )}
              <div className="trust-command-list">
                <p>Executable boundary</p>
                <ul>
                  {disclosedCommands(detected, testExecutable, testArgs).map((command) => (
                    <li key={`${command.label}-${command.value}`}>
                      <span>{command.label}</span>
                      <code>{command.value}</code>
                    </li>
                  ))}
                </ul>
              </div>
              <label className="consent-row">
                <input
                  type="checkbox"
                  aria-label="I trust this repository to run every command listed above."
                  checked={trusted}
                  onChange={(event) => setTrusted(event.target.checked)}
                />
                <span>
                  I trust {detected.trustPreview.canonicalPath} to run every command listed above.
                </span>
              </label>
              <div className="button-row">
                <button className="button quiet" onClick={() => setStep(0)}>
                  <ArrowLeft size={16} aria-hidden="true" /> Back
                </button>
                <button
                  className="button primary"
                  onClick={registerProject}
                  disabled={!trusted || busy}
                >
                  Continue <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
          {step === 2 && project && (
            <>
              <span className="section-icon">
                <KeyRound size={22} aria-hidden="true" />
              </span>
              <p className="eyebrow">Model and release</p>
              <h1 tabIndex={-1}>Connect the essentials.</h1>
              <div className="field-grid two">
                <label>
                  Model provider
                  <select
                    value={provider}
                    onChange={(event) => setProvider(event.target.value as Provider)}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google</option>
                    <option value="openai-compatible">OpenAI-compatible / Ollama</option>
                  </select>
                </label>
                <label>
                  Model ID
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="Provider model ID"
                  />
                </label>
                {provider === 'openai-compatible' ? (
                  <label className="span-two">
                    Endpoint
                    <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
                  </label>
                ) : (
                  <label className="span-two">
                    API key
                    <input
                      type="password"
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                      placeholder="OS vault or current session"
                    />
                  </label>
                )}
                <label>
                  Browser
                  <select
                    value={browserProvider}
                    onChange={(event) => setBrowserProvider(event.target.value as BrowserProvider)}
                  >
                    <option value="local">Local Chrome / Chromium</option>
                    <option value="browserbase">Browserbase</option>
                  </select>
                </label>
                {browserProvider === 'browserbase' && (
                  <>
                    <label>
                      Browserbase project ID
                      <input
                        value={browserbaseProjectId}
                        onChange={(event) => setBrowserbaseProjectId(event.target.value)}
                        placeholder="Required with the API key"
                      />
                    </label>
                    <label className="span-two">
                      Browserbase API key
                      <input
                        type="password"
                        value={browserbaseKey}
                        onChange={(event) => setBrowserbaseKey(event.target.value)}
                        placeholder={
                          browserbaseConfigured ? 'Credential connected' : 'Required to connect'
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="button quiet span-two"
                      onClick={() =>
                        void desktopApi.openExternal('https://www.browserbase.com/overview')
                      }
                    >
                      Open Browserbase <ExternalLink size={15} aria-hidden="true" />
                    </button>
                  </>
                )}
                <label>
                  Publication
                  <select
                    value={publish}
                    onChange={(event) => setPublish(event.target.value as 'github' | 'local')}
                  >
                    <option value="github">GitHub pull request</option>
                    <option value="local">Verified local branch</option>
                  </select>
                </label>
                {publish === 'github' && (
                  <label>
                    GitHub token
                    <input
                      type="password"
                      value={githubToken}
                      onChange={(event) => setGithubToken(event.target.value)}
                      placeholder="Required for GitHub publication"
                    />
                  </label>
                )}
              </div>
              <div className="disclosure">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={weaveEnabled}
                    onChange={(event) => setWeaveEnabled(event.target.checked)}
                  />
                  <span>Send redacted run traces to Weave</span>
                </label>
                {weaveEnabled && (
                  <>
                    <p>Redacted traces only. Raw artifacts stay on this device.</p>
                    <label className="consent-row compact">
                      <input
                        type="checkbox"
                        checked={weaveAccepted}
                        onChange={(event) => setWeaveAccepted(event.target.checked)}
                      />
                      <span>I accept this trace disclosure.</span>
                    </label>
                    <label>
                      W&B API key
                      <input
                        type="password"
                        value={weaveKey}
                        onChange={(event) => setWeaveKey(event.target.value)}
                        placeholder={weaveConfigured ? 'Credential connected' : 'Required to sync'}
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="button-row">
                <button className="button quiet" onClick={() => setStep(1)}>
                  <ArrowLeft size={16} aria-hidden="true" /> Back
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !model ||
                    (browserProvider === 'browserbase' &&
                      (!browserbaseProjectId || (!browserbaseConfigured && !browserbaseKey))) ||
                    (weaveEnabled && (!weaveAccepted || (!weaveConfigured && !weaveKey)))
                  }
                  onClick={configureProject}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={16} aria-hidden="true" />
                  ) : (
                    <Sparkles size={16} aria-hidden="true" />
                  )}{' '}
                  Save and check
                </button>
              </div>
            </>
          )}
          {step === 3 && project && doctor && (
            <>
              <span className="section-icon">
                <Globe2 size={22} aria-hidden="true" />
              </span>
              <div className="readiness-title">
                <div>
                  <p className="eyebrow">Readiness</p>
                  <h1 tabIndex={-1}>
                    {doctor.status === 'blocked'
                      ? 'Setup needs attention.'
                      : doctor.status === 'degraded'
                        ? 'Ready with warnings.'
                        : 'Ready to run.'}
                  </h1>
                </div>
                <StatusPill status={doctor.status} />
              </div>
              <DoctorChecks report={doctor} busy={busy} onAction={applyDoctorAction} />
              {doctor.checks.some((item) => item.id === 'browser' && item.status !== 'pass') && (
                <button className="button secondary" onClick={installBrowser} disabled={busy}>
                  <Globe2 size={16} aria-hidden="true" />
                  {browserProgress === null
                    ? 'Install managed Chrome'
                    : `Downloading ${browserProgress}%`}
                </button>
              )}
              <div className="button-row final">
                <button className="button quiet" disabled={busy} onClick={() => setStep(2)}>
                  <ArrowLeft size={16} aria-hidden="true" /> Edit setup
                </button>
                <button
                  className="button quiet"
                  disabled={busy || doctor.status === 'blocked'}
                  onClick={() => void finishOnboarding(false)}
                >
                  Open project
                </button>
                <button
                  className="button primary"
                  disabled={busy || doctor.status === 'blocked'}
                  onClick={() => void finishOnboarding(true)}
                >
                  <Sparkles size={16} aria-hidden="true" /> Run QA
                </button>
              </div>
            </>
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </section>
        <aside className="setup-agent" aria-label="QAgent setup status">
          <div className="agent-circuit" aria-hidden="true">
            <span />
            <i />
            <span />
          </div>
          <AgentPresence
            mode={signal.mode}
            title={signal.title}
            detail={signal.detail}
            meta={signal.meta}
            progress={busyAction === 'browser' ? browserProgress : undefined}
          />
          <div className="setup-agent-state" aria-hidden="true">
            <span>Observe</span>
            <i />
            <span>Decide</span>
            <i />
            <span>Act</span>
          </div>
          <div className="setup-boundaries">
            <span>
              <ShieldCheck size={14} aria-hidden="true" /> Isolated worktree
            </span>
            <span>
              <KeyRound size={14} aria-hidden="true" /> Credentials outside project data
            </span>
          </div>
        </aside>
      </div>
    </main>
  );
}

function commandLabel(detected: DetectedProjectData): string {
  const command = detected.suggestedTestCommands[0];
  return command ? [command.executable, ...command.args].join(' ') : 'Needs configuration';
}

function onboardingSignal({
  step,
  busyAction,
  detected,
  doctor,
  provider,
  publish,
  browserProgress,
}: {
  step: number;
  busyAction: BusyAction | null;
  detected: DetectedProjectData | null;
  doctor: DoctorReport | null;
  provider: Provider;
  publish: 'github' | 'local';
  browserProgress: number | null;
}): {
  mode: AgentPresenceMode;
  title: string;
  detail: string;
  meta: string;
} {
  if (busyAction === 'inspect') {
    return {
      mode: 'working',
      title: 'Reading project signals',
      detail: 'Stack, manifests, and commands',
      meta: 'Local inspection',
    };
  }
  if (busyAction === 'trust') {
    return {
      mode: 'working',
      title: 'Registering trust',
      detail: detected?.name ?? 'Selected repository',
      meta: 'Local workspace',
    };
  }
  if (busyAction === 'configure') {
    return {
      mode: 'working',
      title: 'Running Doctor',
      detail: 'Browser, Git, model, and policy',
      meta: 'Local readiness checks',
    };
  }
  if (busyAction === 'browser') {
    return {
      mode: 'working',
      title: 'Installing Chromium',
      detail: browserProgress === null ? 'Preparing download' : `${browserProgress}% downloaded`,
      meta: 'Managed browser',
    };
  }
  if (busyAction === 'launch') {
    return {
      mode: 'working',
      title: 'Opening the workspace',
      detail: 'Loading persisted project state',
      meta: 'Local desktop',
    };
  }
  if (step === 0) {
    return {
      mode: 'idle',
      title: 'Waiting for a repository',
      detail: 'Nothing runs until you choose one.',
      meta: 'Local by default',
    };
  }
  if (step === 1) {
    return {
      mode: 'idle',
      title: 'Review before trust',
      detail: detected ? commandLabel(detected) : 'No command detected',
      meta: detected?.stack ?? 'Stack unavailable',
    };
  }
  if (step === 2) {
    return {
      mode: 'idle',
      title: 'Choose the run boundary',
      detail: `${providerName(provider)} / ${publish === 'github' ? 'GitHub PR' : 'local branch'}`,
      meta: 'Credentials stay outside project data',
    };
  }

  const passed = doctor?.checks.filter((check) => check.status === 'pass').length ?? 0;
  const mode =
    doctor?.status === 'blocked' ? 'blocked' : doctor?.status === 'degraded' ? 'degraded' : 'ready';
  return {
    mode,
    title:
      doctor?.status === 'blocked'
        ? 'Resolve blocked checks'
        : doctor?.status === 'degraded'
          ? 'Ready with warnings'
          : 'Ready for the first run',
    detail: doctor ? `${passed} of ${doctor.checks.length} checks passed` : 'Doctor unavailable',
    meta: doctor ? `Observed ${new Date(doctor.checkedAt).toLocaleTimeString()}` : 'No observation',
  };
}

function providerName(provider: Provider): string {
  if (provider === 'openai-compatible') return 'OpenAI-compatible';
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

function disclosedCommands(
  detected: DetectedProjectData,
  testExecutable: string,
  testArgs: string
): Array<{ label: string; value: string }> {
  const entries: Array<{ label: string; value: string }> = [];
  const commands = detected.trustPreview.exactCommands;
  if (commands.start) {
    entries.push({ label: 'Start', value: commandValue(commands.start) });
  }
  commands.test.forEach((command, index) => {
    entries.push({
      label: commands.test.length === 1 ? 'Test' : `Test ${index + 1}`,
      value: commandValue(command),
    });
  });
  commands.verify.forEach((command, index) => {
    entries.push({
      label: commands.verify.length === 1 ? 'Verify' : `Verify ${index + 1}`,
      value: commandValue(command),
    });
  });
  if (entries.length === 0) {
    entries.push({
      label: 'Test and verify',
      value: testExecutable
        ? formatCommand({
            executable: testExecutable,
            args: testArgs.split(/\s+/).filter(Boolean),
            cwd: '.',
            env: {},
            timeoutMs: 300_000,
          })
        : 'Awaiting a command',
    });
  }
  return entries;
}

function commandValue(command: CommandSpec): string {
  return formatCommand(command);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
