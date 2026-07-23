import { useEffect, useState } from 'react';
import type { DoctorReport, Project } from '@qagent/contracts';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Globe2,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { StatusPill } from '../components/status-pill.js';
import type { DetectedProjectData } from '../types.js';

type Provider = 'openai' | 'anthropic' | 'google' | 'openai-compatible';

export function Onboarding({
  onComplete,
}: {
  onComplete: (project: Project, startRun: boolean) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [detected, setDetected] = useState<DetectedProjectData | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [credential, setCredential] = useState('');
  const [publish, setPublish] = useState<'github' | 'local'>('github');
  const [githubToken, setGithubToken] = useState('');
  const [weaveEnabled, setWeaveEnabled] = useState(true);
  const [weaveAccepted, setWeaveAccepted] = useState(false);
  const [weaveKey, setWeaveKey] = useState('');
  const [testExecutable, setTestExecutable] = useState('');
  const [testArgs, setTestArgs] = useState('');
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserProgress, setBrowserProgress] = useState<number | null>(null);

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

  async function chooseProject() {
    setError(null);
    const path = await desktopApi.selectDirectory();
    if (!path) return;
    setBusy(true);
    try {
      setDetected(await desktopApi.inspectProject(path));
      setStep(1);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function registerProject() {
    if (!detected || !trusted) return;
    await runBusy(async () => {
      setProject(await desktopApi.addProject(detected.path, true));
      setStep(2);
    });
  }

  async function configureProject() {
    if (!project || !model || (detected?.suggestedTestCommands.length === 0 && !testExecutable)) {
      setError('Model and test command are required.');
      return;
    }
    await runBusy(async () => {
      if (provider !== 'openai-compatible' && credential) {
        await desktopApi.setCredential(provider, credential);
      }
      if (publish === 'github' && githubToken)
        await desktopApi.setCredential('github', githubToken);
      if (weaveEnabled && weaveKey) await desktopApi.setCredential('weave', weaveKey);
      await desktopApi.setPreferences({
        weaveEnabled,
        weaveDisclosureAccepted: weaveEnabled && weaveAccepted,
      });
      await desktopApi.configureProject({
        projectId: project.id,
        provider,
        model,
        baseUrl: provider === 'openai-compatible' ? baseUrl : undefined,
        publish,
        testExecutable: testExecutable || undefined,
        testArgs: testArgs.split(/\s+/).filter(Boolean),
      });
      setDoctor(await desktopApi.doctor(project.id));
      setStep(3);
    });
  }

  async function installBrowser() {
    await runBusy(async () => {
      setBrowserProgress(0);
      await desktopApi.installBrowser();
      setBrowserProgress(null);
      if (project) setDoctor(await desktopApi.doctor(project.id));
    });
  }

  async function runBusy(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <div className="onboarding-topbar">
        <div className="brand onboarding-brand">
          <span className="brand-mark">Q</span>
          <span className="brand-name">QAgent</span>
        </div>
        <span className="step-count">Setup {step + 1} of 4</span>
      </div>
      <div className="onboarding-layout">
        <ol className="setup-rail" aria-label="Setup progress">
          {['Repository', 'Trust', 'Connections', 'Readiness'].map((label, index) => (
            <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''}>
              <span>{index < step ? <Check size={14} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <section className="setup-content">
          {step === 0 && (
            <>
              <span className="section-icon">
                <FolderOpen size={22} />
              </span>
              <p className="eyebrow">Repository</p>
              <h1>Choose the project QAgent will inspect.</h1>
              <p className="setup-lede">
                Its checkout stays untouched. Repairs are made in isolated Git worktrees.
              </p>
              <button className="button primary" onClick={chooseProject} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <FolderOpen size={17} />}
                Choose folder
              </button>
            </>
          )}
          {step === 1 && detected && (
            <>
              <span className="section-icon">
                <ShieldCheck size={22} />
              </span>
              <p className="eyebrow">Workspace trust</p>
              <h1>{detected.name}</h1>
              <dl className="repository-facts">
                <div>
                  <dt>Location</dt>
                  <dd>{detected.path}</dd>
                </div>
                <div>
                  <dt>Stack</dt>
                  <dd>{detected.stack}</dd>
                </div>
                <div>
                  <dt>Test command</dt>
                  <dd>{commandLabel(detected)}</dd>
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
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={trusted}
                  onChange={(event) => setTrusted(event.target.checked)}
                />
                <span>I trust this repository to run the commands shown above.</span>
              </label>
              <div className="button-row">
                <button className="button quiet" onClick={() => setStep(0)}>
                  <ArrowLeft size={16} /> Back
                </button>
                <button
                  className="button primary"
                  onClick={registerProject}
                  disabled={!trusted || busy}
                >
                  Continue <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}
          {step === 2 && project && (
            <>
              <span className="section-icon">
                <KeyRound size={22} />
              </span>
              <p className="eyebrow">Connections</p>
              <h1>Connect this project.</h1>
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
                      placeholder="Stored with OS encryption"
                    />
                  </label>
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
                      placeholder="Optional until publish"
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
                    <p>
                      Inputs and outputs are redacted locally. Source files, screenshots, and raw
                      artifacts stay on this device.
                    </p>
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
                        placeholder="Optional; local-only without it"
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="button-row">
                <button className="button quiet" onClick={() => setStep(1)}>
                  <ArrowLeft size={16} /> Back
                </button>
                <button
                  className="button primary"
                  disabled={busy || !model || (weaveEnabled && !weaveAccepted)}
                  onClick={configureProject}
                >
                  {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Save
                  and check
                </button>
              </div>
            </>
          )}
          {step === 3 && project && doctor && (
            <>
              <span className="section-icon">
                <Globe2 size={22} />
              </span>
              <div className="readiness-title">
                <div>
                  <p className="eyebrow">Readiness</p>
                  <h1>Local checks are complete.</h1>
                </div>
                <StatusPill status={doctor.status} />
              </div>
              <div className="doctor-list">
                {doctor.checks.map((item) => (
                  <div key={item.id} className="doctor-row">
                    <StatusPill
                      status={
                        item.status === 'warn'
                          ? 'degraded'
                          : item.status === 'fail'
                            ? 'blocked'
                            : 'ready'
                      }
                    />
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.detail}</p>
                      <small>{item.source}</small>
                    </div>
                  </div>
                ))}
              </div>
              {doctor.checks.some((item) => item.id === 'browser' && item.status !== 'pass') && (
                <button className="button secondary" onClick={installBrowser} disabled={busy}>
                  <Globe2 size={16} />
                  {browserProgress === null
                    ? 'Install managed Chrome'
                    : `Downloading ${browserProgress}%`}
                </button>
              )}
              <div className="button-row final">
                <button className="button quiet" onClick={() => void onComplete(project, false)}>
                  Open project
                </button>
                <button
                  className="button primary"
                  disabled={doctor.status === 'blocked'}
                  onClick={() => void onComplete(project, true)}
                >
                  <Sparkles size={16} /> Run QA
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
      </div>
    </main>
  );
}

function commandLabel(detected: DetectedProjectData): string {
  const command = detected.suggestedTestCommands[0];
  return command ? [command.executable, ...command.args].join(' ') : 'Needs configuration';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
