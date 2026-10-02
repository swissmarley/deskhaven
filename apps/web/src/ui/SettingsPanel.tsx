import type { AuthStatus, Settings } from '@agenthotel/shared';
import { type JSX, useCallback, useEffect, useState } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { PresetsEditor } from './PresetsEditor.js';

export function SettingsPanel(): JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void api
      .authStatus()
      .then(setAuth)
      .catch((err) => pushNotice('error', String(err)));
  }, [pushNotice]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const update = async (patch: Partial<Settings>) => {
    setBusy(true);
    try {
      await api.updateSettings(patch);
      refresh();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const storeKey = async () => {
    setBusy(true);
    try {
      await api.storeApiKey(key);
      setKey('');
      refresh();
      pushNotice('info', 'API key stored in the OS keychain');
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <p className="muted">Loading…</p>;

  return (
    <div className="panel">
      <h3>Settings</h3>
      <section className="card">
        <h4>Authentication</h4>
        <div className="row wrap">
          <label className="inline">
            <input
              type="radio"
              name="authMode"
              checked={settings.authMode === 'API_KEY'}
              disabled={busy}
              onChange={() => void update({ authMode: 'API_KEY' })}
            />{' '}
            API key
          </label>
          <label
            className="inline"
            title={settings.subscriptionModeEnabled ? '' : 'Disabled by the feature flag'}
          >
            <input
              type="radio"
              name="authMode"
              checked={settings.authMode === 'CLAUDE_SUBSCRIPTION'}
              disabled={busy || !settings.subscriptionModeEnabled}
              onChange={() => void update({ authMode: 'CLAUDE_SUBSCRIPTION' })}
            />{' '}
            Claude subscription (Pro/Max login)
          </label>
        </div>
        {auth ? (
          <div className={`auth-status ${auth.available ? 'ok' : 'bad'}`}>
            <span className={`dot ${auth.available ? 'ok' : 'bad'}`} />
            {auth.mode === 'API_KEY'
              ? auth.available
                ? `Key found (${auth.keySource})`
                : 'No API key configured'
              : auth.available
                ? `Logged in${auth.subscriptionType ? ` · ${auth.subscriptionType} plan` : ''}${auth.email ? ` · ${auth.email}` : ''}`
                : 'Not logged in'}
            {auth.error ? <p className="error small">{auth.error}</p> : null}
            <button type="button" className="link" onClick={refresh}>
              refresh
            </button>
          </div>
        ) : null}
        {settings.authMode === 'API_KEY' ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void storeKey();
            }}
          >
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-… (stored in the OS keychain, never shown again)"
              autoComplete="off"
            />
            <button type="submit" className="primary" disabled={busy || key.length < 10}>
              Store
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void api.clearApiKey().then(refresh)}
            >
              Clear
            </button>
          </form>
        ) : (
          <div className="notice">
            <p>
              Sign in with <code>claude login</code> in your own terminal. AgentHotel never sees or
              stores your token; it only strips API-key variables from the agent processes so your
              plan is used.
            </p>
            <p>{auth?.notice}</p>
            <p className="muted small">
              Policy last checked {settings.policyCheckedAt}: SDK usage on Pro/Max draws from your
              plan limits; third-party login/token handling is not allowed and this app does
              neither. Details in ARCHITECTURE.md §5.1.
            </p>
          </div>
        )}
      </section>
      <section className="card">
        <h4>Limits</h4>
        <label>
          Concurrent agents (cap)
          <input
            type="number"
            min={1}
            max={16}
            value={settings.concurrencyCap}
            disabled={busy}
            onChange={(e) => void update({ concurrencyCap: Number(e.target.value) })}
          />
        </label>
        <label>
          Daily cost cap (USD, estimate)
          <input
            type="number"
            min={0}
            step={1}
            value={settings.dailyCapUsd}
            disabled={busy}
            onChange={(e) => void update({ dailyCapUsd: Number(e.target.value) })}
          />
        </label>
        <label>
          Permission timeout (minutes)
          <input
            type="number"
            min={1}
            value={Math.round(settings.permissionTimeoutMs / 60000)}
            disabled={busy}
            onChange={(e) => void update({ permissionTimeoutMs: Number(e.target.value) * 60000 })}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={settings.soundEnabled}
            disabled={busy}
            onChange={(e) => void update({ soundEnabled: e.target.checked })}
          />{' '}
          Sounds
        </label>
      </section>
      <PresetsEditor />
    </div>
  );
}
