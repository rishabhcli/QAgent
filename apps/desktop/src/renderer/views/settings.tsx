import { useEffect, useRef, useState } from 'react';
import type {
  CorrectiveAction,
  DoctorReport,
  Integration,
  IntegrationProvider,
  Project,
  Provenance,
} from '@qagent/contracts';
import type { CredentialStatus, DesktopPreferences } from '../../ipc.js';
import {
  Check,
  ExternalLink,
  Globe2,
  Cloud,
  Database,
  GitBranch,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Server,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { DoctorChecks } from '../components/doctor-checks.js';
import { SourceStamp } from '../components/source-stamp.js';
import { StatusPill } from '../components/status-pill.js';

const credentialDefinitions = [
  { id: 'openai', label: 'OpenAI', icon: KeyRound },
  { id: 'anthropic', label: 'Anthropic', icon: KeyRound },
  { id: 'google', label: 'Google', icon: KeyRound },
  {
    id: 'github',
    label: 'GitHub',
    icon: GitBranch,
    connectionUrl: 'https://github.com/settings/personal-access-tokens',
  },
  {
    id: 'weave',
    label: 'W&B Weave',
    icon: Cloud,
    connectionUrl: 'https://wandb.ai/authorize',
  },
  {
    id: 'browserbase',
    label: 'Browserbase',
    icon: Server,
    connectionUrl: 'https://www.browserbase.com/overview',
  },
];

export function SettingsView({
  integrations,
  provenance,
  hasActiveRun,
  project,
  onConfigureProject,
  onRefresh,
}: {
  integrations: Integration[];
  provenance: Provenance;
  hasActiveRun: boolean;
  project: Project | null;
  onConfigureProject: (project: Project) => void;
  onRefresh: () => Promise<void>;
}) {
  const [statuses, setStatuses] = useState<CredentialStatus[]>([]);
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [browserbaseProjectIdDraft, setBrowserbaseProjectIdDraft] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<IntegrationProvider | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [browserProgress, setBrowserProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const traceSectionRef = useRef<HTMLElement>(null);
  const traceDisclosureRef = useRef<HTMLInputElement>(null);
  const limitedCredentialStorage = statuses.find((status) => status.storage !== 'encrypted');
  const settingsLoaded = preferences !== null && statuses.length > 0;
  const configuredCredentials = statuses.filter((status) => status.configured).length;
  const healthyIntegrations = integrations.filter(
    (integration) =>
      integration.status === 'healthy' || integration.status === 'end-to-end-verified'
  ).length;
  const weaveCredential = statuses.find((status) => status.provider === 'weave');
  const weaveActive = Boolean(
    weaveCredential?.configured && preferences?.weaveEnabled && preferences.weaveDisclosureAccepted
  );
  const browserReady = Boolean(
    doctor?.checks.some((check) => check.id === 'browser' && check.status === 'pass')
  );

  useEffect(() => {
    void loadSettings();
    return window.qagent.onEvent((event) => {
      if (event.type !== 'browser.progress') return;
      const value = event.data as { downloadedBytes: number; totalBytes: number };
      setBrowserProgress(
        value.totalBytes ? Math.round((value.downloadedBytes / value.totalBytes) * 100) : 0
      );
    });
  }, []);

  async function loadSettings() {
    try {
      const [credentialStatuses, currentPreferences] = await Promise.all([
        desktopApi.credentialStatuses(),
        desktopApi.getPreferences(),
      ]);
      setStatuses(credentialStatuses);
      setPreferences(currentPreferences);
      setBrowserbaseProjectIdDraft(currentPreferences.browserbaseProjectId);
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function saveCredential(provider: string) {
    if (!preferences) return;
    setSaving(provider);
    setError(null);
    try {
      const credential = keys[provider] ?? '';
      if (provider === 'browserbase') {
        const projectId = browserbaseProjectIdDraft.trim();
        if (!projectId) throw new Error('Browserbase project ID is required with the API key.');
        if (credential) {
          await desktopApi.setCredential(provider, credential, { deferRestart: true });
        }
        const next = { ...preferences, browserbaseProjectId: projectId };
        await desktopApi.setPreferences(next);
        setPreferences(next);
      } else {
        await desktopApi.setCredential(provider, credential);
      }
      setKeys((current) => ({ ...current, [provider]: '' }));
      await loadSettings();
      await onRefresh();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(null);
    }
  }
  async function savePreferences(next: DesktopPreferences) {
    const previous = preferences;
    setSaving('preferences');
    setError(null);
    setPreferences(next);
    try {
      await desktopApi.setPreferences(next);
      await onRefresh();
    } catch (caught) {
      setPreferences(previous);
      setError(message(caught));
    } finally {
      setSaving(null);
    }
  }
  async function runChecks() {
    setSaving('doctor');
    setError(null);
    try {
      setDoctor(await desktopApi.doctor(project?.id));
      setError(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(null);
    }
  }
  async function installBrowser() {
    setSaving('browser');
    setBrowserProgress(0);
    setError(null);
    try {
      await desktopApi.installBrowser();
      setDoctor(await desktopApi.doctor(project?.id));
      setError(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(null);
      setBrowserProgress(null);
    }
  }

  async function verifyConnection(integration: Integration) {
    const provider = integrationProvider(integration.provider);
    if (!provider) return;
    setVerifying(provider);
    setError(null);
    try {
      await desktopApi.verifyIntegration({
        provider,
        projectId: project?.id,
        requestedBy: 'desktop',
        weaveDisclosureAccepted: preferences?.weaveDisclosureAccepted ?? false,
      });
      await onRefresh();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setVerifying(null);
    }
  }

  async function applyDoctorAction(action: CorrectiveAction) {
    if (action.type === 'command' || action.type === 'run') return;
    setError(null);
    try {
      if (action.type === 'external') {
        await desktopApi.openExternal(action.url);
        return;
      }
      if (
        (action.action === 'configure_project' || action.action === 'configure_provider') &&
        project
      ) {
        onConfigureProject(project);
        return;
      }
      if (action.action === 'install_browser') {
        await installBrowser();
        return;
      }
      if (action.action === 'review_policy') {
        traceSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        traceDisclosureRef.current?.focus();
        return;
      }
      if (action.action === 'trust_project' && project) {
        await desktopApi.trustProject(project.id, true);
        await onRefresh();
      }
      if (action.action === 'rerun_doctor' || action.action === 'trust_project') {
        await runChecks();
      }
    } catch (caught) {
      setError(message(caught));
    }
  }

  return (
    <div className="view-stack settings-view">
      <section className="simple-heading">
        <div>
          <p className="eyebrow">Local configuration</p>
          <h2>Settings</h2>
          <p>
            Signed builds use operating system encryption; other builds keep secrets in session.
          </p>
        </div>
        <SourceStamp provenance={provenance} />
      </section>
      <section
        className="settings-status-rail"
        aria-label="Configuration status"
        data-active={!settingsLoaded || saving ? 'true' : 'false'}
      >
        <div>
          <span className="settings-status-icon">
            <KeyRound size={16} aria-hidden="true" />
          </span>
          <span>
            <strong>
              {settingsLoaded
                ? `${configuredCredentials} / ${credentialDefinitions.length}`
                : 'Checking'}
            </strong>
            <small>Credentials</small>
          </span>
        </div>
        <div>
          <span className="settings-status-icon trace">
            <Cloud size={16} aria-hidden="true" />
          </span>
          <span>
            <strong>
              {preferences ? (weaveActive ? 'Sync enabled' : 'Local only') : 'Checking'}
            </strong>
            <small>Trace mode</small>
          </span>
        </div>
        <div>
          <span className="settings-status-icon adapter">
            <Server size={16} aria-hidden="true" />
          </span>
          <span>
            <strong>
              {integrations.length
                ? healthyIntegrations > 0
                  ? `${healthyIntegrations} healthy`
                  : 'None healthy'
                : 'Unavailable'}
            </strong>
            <small>Adapters</small>
          </span>
        </div>
        <span className="settings-live-line" aria-hidden="true">
          <i />
        </span>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Credentials</p>
            <h3>Provider connections</h3>
          </div>
        </div>
        <div className="credentials-list">
          {credentialDefinitions.map(({ id, label, icon: Icon, connectionUrl }) => {
            const status = statuses.find((item) => item.provider === id);
            const integration = integrations.find((item) => item.provider === id);
            const browserbaseProjectChanged =
              id === 'browserbase' &&
              browserbaseProjectIdDraft.trim() !== preferences?.browserbaseProjectId;
            return (
              <div
                className={saving === id ? 'credential-row saving' : 'credential-row'}
                key={id}
                data-provider={id}
              >
                <span className="integration-icon">
                  <Icon size={18} />
                </span>
                <div className="credential-name">
                  <strong>{label}</strong>
                  <small>{status?.storage ?? 'checking'}</small>
                </div>
                <StatusPill
                  status={
                    integration?.status ??
                    (status ? (status.configured ? 'configured' : 'unconfigured') : 'checking')
                  }
                />
                <div
                  className={
                    id === 'browserbase'
                      ? 'credential-control browserbase-control'
                      : connectionUrl
                        ? 'credential-control linked-control'
                        : 'credential-control'
                  }
                >
                  {id === 'browserbase' && (
                    <input
                      value={browserbaseProjectIdDraft}
                      onChange={(event) => setBrowserbaseProjectIdDraft(event.target.value)}
                      placeholder="Browserbase project ID"
                      aria-label="Browserbase project ID"
                    />
                  )}
                  <input
                    type="password"
                    value={keys[id] ?? ''}
                    onChange={(event) =>
                      setKeys((current) => ({ ...current, [id]: event.target.value }))
                    }
                    placeholder={status?.configured ? 'Replace credential' : 'Enter credential'}
                    aria-label={`${label} credential`}
                  />
                  <button
                    className="icon-button"
                    title={`Save ${label} credential`}
                    disabled={
                      hasActiveRun ||
                      saving === id ||
                      (!(keys[id] ?? '') && !browserbaseProjectChanged)
                    }
                    onClick={() => void saveCredential(id)}
                  >
                    {saving === id ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Check size={16} />
                    )}
                  </button>
                  {connectionUrl && (
                    <button
                      type="button"
                      className="icon-button"
                      title={`Open ${label} connection page`}
                      onClick={() => void desktopApi.openExternal(connectionUrl)}
                    >
                      <ExternalLink size={16} />
                    </button>
                  )}
                </div>
                <i className="credential-save-line" aria-hidden="true" />
              </div>
            );
          })}
        </div>
        {limitedCredentialStorage && (
          <div className="inline-notice" role="status">
            <strong>Encrypted credential storage is unavailable.</strong>
            <p>
              QAgent will use environment or session credentials only and will not persist new
              secrets on this device.
            </p>
          </div>
        )}
        {hasActiveRun && (
          <div className="inline-notice" role="status">
            <strong>Runtime settings are locked while a run is active.</strong>
            <p>
              The active run keeps its current credentials and trace boundary until it finishes.
            </p>
          </div>
        )}
      </section>
      <div className="settings-lower-grid">
        <section className="settings-section trace-section" ref={traceSectionRef}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Trace privacy</p>
              <h3>W&B Weave</h3>
            </div>
            <StatusPill
              status={preferences === null ? 'checking' : weaveActive ? 'configured' : 'disabled'}
            />
          </div>
          {preferences && (
            <div className="privacy-controls">
              <label className="toggle-row switch-row">
                <input
                  type="checkbox"
                  checked={preferences.weaveEnabled}
                  disabled={
                    hasActiveRun ||
                    saving === 'preferences' ||
                    !weaveCredential?.configured ||
                    !preferences.weaveDisclosureAccepted
                  }
                  onChange={(event) =>
                    void savePreferences({ ...preferences, weaveEnabled: event.target.checked })
                  }
                />
                <span>Enable redacted traces after connection</span>
              </label>
              <label className="consent-row compact">
                <input
                  ref={traceDisclosureRef}
                  type="checkbox"
                  checked={preferences.weaveDisclosureAccepted}
                  disabled={
                    hasActiveRun || saving === 'preferences' || !weaveCredential?.configured
                  }
                  onChange={(event) =>
                    void savePreferences({
                      ...preferences,
                      weaveDisclosureAccepted: event.target.checked,
                      weaveEnabled: event.target.checked ? preferences.weaveEnabled : false,
                    })
                  }
                />
                <span>I accept redacted inputs and outputs. Raw artifacts stay local.</span>
              </label>
              {!weaveCredential?.configured && (
                <p className="preference-availability">
                  Connect W&B Weave above before enabling trace sync.
                </p>
              )}
            </div>
          )}
        </section>
        <section className="settings-section adapter-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Optional adapters</p>
              <h3>Local readiness</h3>
            </div>
            <button
              className="button quiet compact-button"
              disabled={saving === 'doctor'}
              onClick={() => void runChecks()}
            >
              <RefreshCw size={14} className={saving === 'doctor' ? 'spin' : ''} /> Doctor
            </button>
          </div>
          <div className="integration-grid">
            {integrations.map((integration) => {
              const sourceFact = integrationSourceFact(integration);
              return (
                <article key={integration.provider} className="integration-item">
                  <span className="integration-icon">
                    {integration.provider === 'redis' ? (
                      <Database size={18} />
                    ) : integration.provider === 'github' ? (
                      <GitBranch size={18} />
                    ) : (
                      <Cloud size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{integration.provider}</strong>
                    <p>{integration.detail}</p>
                    {integration.requirements && integration.requirements.length > 0 && (
                      <p>
                        {integration.requirements
                          .map((requirement) => `${requirement.label}: ${requirement.state}`)
                          .join(' · ')}
                      </p>
                    )}
                    {sourceFact && (
                      <button
                        type="button"
                        className="evidence-source-link"
                        onClick={() => void desktopApi.openExternal(sourceFact.sourceUrl)}
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        {sourceFact.label} · {new Date(sourceFact.capturedAt).toLocaleString()}
                      </button>
                    )}
                  </div>
                  <div className="integration-actions">
                    <StatusPill status={integration.status} />
                    {integrationProvider(integration.provider) && (
                      <button
                        type="button"
                        className="icon-button"
                        title={`Check ${integration.provider} connection`}
                        disabled={verifying === integrationProvider(integration.provider)}
                        onClick={() => void verifyConnection(integration)}
                      >
                        <RefreshCw
                          size={15}
                          className={
                            verifying === integrationProvider(integration.provider) ? 'spin' : ''
                          }
                        />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {doctor && (
            <div className="compact-doctor">
              <DoctorChecks
                report={doctor}
                busy={saving === 'doctor' || saving === 'browser'}
                onAction={applyDoctorAction}
              />
            </div>
          )}
          <button
            className="button secondary"
            disabled={hasActiveRun || saving === 'browser' || browserReady}
            onClick={() => void installBrowser()}
          >
            <Globe2 size={16} />
            {browserReady
              ? 'Browser ready'
              : browserProgress === null
                ? 'Install managed Chrome'
                : `Downloading ${browserProgress}%`}
          </button>
        </section>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integrationProvider(provider: string): IntegrationProvider | null {
  if (['openai', 'anthropic', 'google', 'openai-compatible', 'model'].includes(provider)) {
    return 'model';
  }
  if (provider === 'browser' || provider === 'browserbase') return 'browser';
  if (provider === 'github' || provider === 'weave') return provider;
  return null;
}

function integrationSourceFact(
  integration: Integration
): { sourceUrl: string; capturedAt: string; label: string } | null {
  const evidence = integration.evidence?.at(-1);
  if (evidence) {
    return {
      sourceUrl: evidence.sourceUrl,
      capturedAt: evidence.capturedAt,
      label: evidence.authorization,
    };
  }
  if (!integration.provenance.sourceUrl) return null;
  return {
    sourceUrl: integration.provenance.sourceUrl,
    capturedAt: integration.provenance.capturedAt,
    label: 'observed, not verified',
  };
}
