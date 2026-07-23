import { useEffect, useState } from 'react';
import type { DoctorReport, Integration, Provenance } from '@qagent/contracts';
import type { CredentialStatus, DesktopPreferences } from '../../ipc.js';
import {
  Check,
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
import { SourceStamp } from '../components/source-stamp.js';
import { StatusPill } from '../components/status-pill.js';

const credentialDefinitions = [
  { id: 'openai', label: 'OpenAI', icon: KeyRound },
  { id: 'anthropic', label: 'Anthropic', icon: KeyRound },
  { id: 'google', label: 'Google', icon: KeyRound },
  { id: 'github', label: 'GitHub', icon: GitBranch },
  { id: 'weave', label: 'W&B Weave', icon: Cloud },
  { id: 'browserbase', label: 'Browserbase', icon: Server },
];

export function SettingsView({
  integrations,
  provenance,
  onRefresh,
}: {
  integrations: Integration[];
  provenance: Provenance;
  onRefresh: () => Promise<void>;
}) {
  const [statuses, setStatuses] = useState<CredentialStatus[]>([]);
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [browserProgress, setBrowserProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limitedCredentialStorage = statuses.find((status) => status.storage !== 'encrypted');

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
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function saveCredential(provider: string) {
    setSaving(provider);
    setError(null);
    try {
      await desktopApi.setCredential(provider, keys[provider] ?? '');
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
    setPreferences(next);
    try {
      await desktopApi.setPreferences(next);
      await onRefresh();
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function runChecks() {
    setSaving('doctor');
    try {
      setDoctor(await desktopApi.doctor());
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(null);
    }
  }
  async function installBrowser() {
    setSaving('browser');
    setBrowserProgress(0);
    try {
      await desktopApi.installBrowser();
      setDoctor(await desktopApi.doctor());
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(null);
      setBrowserProgress(null);
    }
  }

  return (
    <div className="view-stack settings-view">
      <section className="simple-heading">
        <div>
          <p className="eyebrow">Local configuration</p>
          <h2>Settings</h2>
          <p>Credentials use operating system encryption when it is available.</p>
        </div>
        <SourceStamp provenance={provenance} />
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Credentials</p>
            <h3>Provider connections</h3>
          </div>
        </div>
        <div className="credentials-list">
          {credentialDefinitions.map(({ id, label, icon: Icon }) => {
            const status = statuses.find((item) => item.provider === id);
            return (
              <div className="credential-row" key={id}>
                <span className="integration-icon">
                  <Icon size={18} />
                </span>
                <div className="credential-name">
                  <strong>{label}</strong>
                  <small>{status?.storage ?? 'checking'}</small>
                </div>
                <StatusPill status={status?.configured ? 'configured' : 'unconfigured'} />
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
                  disabled={saving === id || !(keys[id] ?? '')}
                  onClick={() => void saveCredential(id)}
                >
                  {saving === id ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}
                </button>
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
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Trace privacy</p>
            <h3>W&B Weave</h3>
          </div>
          <StatusPill
            status={
              preferences?.weaveEnabled && preferences.weaveDisclosureAccepted
                ? 'configured'
                : 'unconfigured'
            }
          />
        </div>
        {preferences && (
          <div className="privacy-controls">
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={preferences.weaveEnabled}
                onChange={(event) =>
                  void savePreferences({ ...preferences, weaveEnabled: event.target.checked })
                }
              />
              <span>Enable redacted traces after connection</span>
            </label>
            <label className="consent-row compact">
              <input
                type="checkbox"
                checked={preferences.weaveDisclosureAccepted}
                onChange={(event) =>
                  void savePreferences({
                    ...preferences,
                    weaveDisclosureAccepted: event.target.checked,
                  })
                }
              />
              <span>I accept sending redacted inputs and outputs. Raw artifacts stay local.</span>
            </label>
          </div>
        )}
      </section>
      <section className="settings-section">
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
          {integrations.map((integration) => (
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
              </div>
              <StatusPill status={integration.status} />
            </article>
          ))}
        </div>
        {doctor && (
          <div className="doctor-list compact-doctor">
            {doctor.checks.map((item) => (
              <div className="doctor-row" key={item.id}>
                <StatusPill
                  status={
                    item.status === 'pass'
                      ? 'ready'
                      : item.status === 'warn'
                        ? 'degraded'
                        : 'blocked'
                  }
                />
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className="button secondary"
          disabled={saving === 'browser'}
          onClick={() => void installBrowser()}
        >
          <Globe2 size={16} />
          {browserProgress === null ? 'Install managed Chrome' : `Downloading ${browserProgress}%`}
        </button>
      </section>
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
