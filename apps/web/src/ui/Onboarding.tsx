import type { AuthStatus } from '@agenthotel/shared';
import { type JSX, useEffect, useState } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { AgentForm } from './AgentForm.js';

type Step = 'auth' | 'workspace' | 'hire';

/** First-run wizard: pick the auth mode, prepare a workspace, hire the first agent. */
export function Onboarding(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings);
  const agentCount = useAppStore((s) => Object.keys(s.agents).length);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [step, setStep] = useState<Step>('auth');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [key, setKey] = useState('');
  const [samplePath, setSamplePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings && !settings.onboarded)
      void api
        .authStatus()
        .then(setAuth)
        .catch(() => setAuth(null));
  }, [settings]);

  if (!settings || settings.onboarded) return null;

  const finish = async () => {
    try {
      await api.updateSettings({ onboarded: true });
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    }
  };

  const chooseMode = async (mode: 'API_KEY' | 'CLAUDE_SUBSCRIPTION') => {
    setBusy(true);
    try {
      await api.updateSettings({
        authMode: mode,
        concurrencyCap: mode === 'CLAUDE_SUBSCRIPTION' ? 2 : 4,
      });
      setAuth(await api.authStatus());
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
      setAuth(await api.authStatus());
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const prepareSample = async () => {
    setBusy(true);
    try {
      setSamplePath((await api.sampleInit()).path);
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal onboarding"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Deskhaven"
      >
        <div className="panel-head">
          <h3>Welcome to Deskhaven</h3>
          <span className="muted small">
            step {step === 'auth' ? 1 : step === 'workspace' ? 2 : 3} of 3
          </span>
        </div>
        {step === 'auth' ? (
          <>
            <p>
              Every avatar here is a real Claude Code agent. First, choose how they authenticate.
            </p>
            <div className="choice-grid">
              <button
                type="button"
                className={`choice ${settings.authMode === 'API_KEY' ? 'active' : ''}`}
                disabled={busy}
                onClick={() => void chooseMode('API_KEY')}
              >
                <strong>API key</strong>
                <span className="small">
                  Billed per token to your Anthropic API account. The key goes to the OS keychain
                  and only ever reaches the agent processes.
                </span>
              </button>
              <button
                type="button"
                className={`choice ${settings.authMode === 'CLAUDE_SUBSCRIPTION' ? 'active' : ''}`}
                disabled={busy || !settings.subscriptionModeEnabled}
                onClick={() => void chooseMode('CLAUDE_SUBSCRIPTION')}
              >
                <strong>Claude subscription (Pro/Max)</strong>
                <span className="small">
                  Uses the login from <code>claude login</code> in your terminal. Usage counts
                  against your plan; concurrency is capped at 2. No tokens are read or stored by
                  this app.
                </span>
              </button>
            </div>
            {auth ? (
              <p className={`small ${auth.available ? 'ok' : 'error'}`}>
                {auth.mode === 'API_KEY'
                  ? auth.available
                    ? `✓ Key found (${auth.keySource})`
                    : 'No key yet. Paste one below or set ANTHROPIC_API_KEY before starting the server.'
                  : auth.available
                    ? `✓ Logged in${auth.subscriptionType ? ` · ${auth.subscriptionType} plan` : ''}`
                    : (auth.error ?? 'Not logged in')}
              </p>
            ) : null}
            {settings.authMode === 'API_KEY' && auth && !auth.available ? (
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
                  placeholder="sk-ant-…"
                  autoComplete="off"
                />
                <button type="submit" className="primary" disabled={busy || key.length < 10}>
                  Store in keychain
                </button>
              </form>
            ) : null}
            <p className="muted small">
              Policy checked {settings.policyCheckedAt}: Agent SDK usage on Pro/Max draws from the
              plan's limits; apps may not offer Claude.ai login or handle tokens, and this one does
              neither. See ARCHITECTURE.md §5.1.
            </p>
            <div className="row">
              <button type="button" className="link" onClick={() => void finish()}>
                Skip setup
              </button>
              <span className="spacer" />
              <button
                type="button"
                className="primary"
                disabled={!auth?.available}
                onClick={() => setStep('workspace')}
              >
                Continue
              </button>
            </div>
          </>
        ) : null}
        {step === 'workspace' ? (
          <>
            <p>
              Agents work inside a directory you choose (or a git worktree of it). For a first try,
              use the bundled sample project: a tiny TypeScript CLI with a planted bug and a missing
              function.
            </p>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => void prepareSample()}>
                Prepare the sample repo
              </button>
              {samplePath ? <code className="small">{samplePath}</code> : null}
            </div>
            <p className="muted small">
              Everything Deskhaven stores lives under ~/.agenthotel (database, worktrees, sample
              repo).
            </p>
            <div className="row">
              <button type="button" onClick={() => setStep('auth')}>
                Back
              </button>
              <span className="spacer" />
              <button type="button" className="primary" onClick={() => setStep('hire')}>
                Continue
              </button>
            </div>
          </>
        ) : null}
        {step === 'hire' ? (
          <>
            <p>
              Hire your first agent. An Engineer can edit files; try the task “Fix mean() in
              src/stats.ts so npm test passes” afterwards.
            </p>
            <AgentForm initialWorkdir={samplePath ?? ''} onDone={() => void finish()} />
            <div className="row">
              <button type="button" onClick={() => setStep('workspace')}>
                Back
              </button>
              <span className="spacer" />
              <button type="button" className="link" onClick={() => void finish()}>
                {agentCount ? 'Done' : 'Skip for now'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
