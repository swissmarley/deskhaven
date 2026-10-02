import type { PermissionMode, RolePreset } from '@agenthotel/shared';
import { type JSX, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../net/api.js';
import { selectAgentList, useAppStore } from '../state/store.js';
import { fmtUsd } from './eventText.js';

export function AgentsPanel(): JSX.Element {
  const agents = useAppStore(useShallow(selectAgentList));
  const selectAgent = useAppStore((s) => s.selectAgent);
  const [creating, setCreating] = useState(agents.length === 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>HR desk</h3>
        <button type="button" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Close' : 'New agent'}
        </button>
      </div>
      {creating ? <CreateAgentForm onDone={() => setCreating(false)} /> : null}
      <ul className="agent-list">
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className="agent-row" onClick={() => selectAgent(a.id)}>
              <span className="swatch" style={{ background: a.avatar.shirt }} />
              <span className="agent-name">{a.name}</span>
              <span className="muted">{a.rolePresetId}</span>
              <span className={`pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
              <span className="muted">{fmtUsd(a.usage.costUsd)}</span>
            </button>
          </li>
        ))}
        {agents.length === 0 ? <li className="muted">No agents yet. Create one above.</li> : null}
      </ul>
    </div>
  );
}

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Ask (default)' },
  { id: 'acceptEdits', label: 'Accept edits, ask for the rest' },
  { id: 'plan', label: 'Plan only (no execution)' },
  { id: 'dontAsk', label: "Don't ask: deny anything not pre-approved" },
];

export function CreateAgentForm({ onDone }: { onDone: () => void }): JSX.Element {
  const pushNotice = useAppStore((s) => s.pushNotice);
  const settings = useAppStore((s) => s.settings);
  const [presets, setPresets] = useState<RolePreset[]>([]);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [name, setName] = useState('');
  const [rolePresetId, setRole] = useState('engineer');
  const [workdir, setWorkdir] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxBudgetUsd, setMaxBudget] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .presets()
      .then(setPresets)
      .catch(() => setPresets([]));
    void api
      .models()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const preset = presets.find((p) => p.id === rolePresetId);

  const submit = async () => {
    setBusy(true);
    try {
      const budget: { maxTurns?: number; maxBudgetUsd?: number } = {};
      if (maxTurns) budget.maxTurns = Number(maxTurns);
      if (maxBudgetUsd) budget.maxBudgetUsd = Number(maxBudgetUsd);
      await api.createAgent({
        name: name || `${preset?.name ?? 'Agent'} ${Math.floor(Math.random() * 90 + 10)}`,
        rolePresetId,
        workdir,
        ...(model ? { model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        budget,
        useWorktree,
      });
      onDone();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const prepareSample = async () => {
    try {
      const r = await fetch('/api/sample/init', { method: 'POST' });
      const j = (await r.json()) as { path?: string; error?: string };
      if (j.path) setWorkdir(j.path);
      else pushNotice('error', j.error ?? 'could not prepare the sample repo');
    } catch (err) {
      pushNotice('error', String(err));
    }
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" />
      </label>
      <label>
        Role
        <select value={rolePresetId} onChange={(e) => setRole(e.target.value)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {preset ? <p className="muted small">{preset.description}</p> : null}
      <label>
        Working directory
        <input
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          placeholder="/path/to/repo"
          required
        />
      </label>
      <div className="row">
        <button type="button" onClick={() => void prepareSample()}>
          Use the sample repo
        </button>
        <label className="inline">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />{' '}
          git worktree
        </label>
      </div>
      <label>
        Model
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">
            {preset?.manager
              ? `Manager default (${settings?.managerModel ?? ''})`
              : `Default (${settings?.defaultModel ?? ''})`}
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Permissions
        <select
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionMode | '')}
        >
          <option value="">Preset default ({preset?.permissionMode ?? 'default'})</option>
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label>
          Max turns
          <input
            type="number"
            min={1}
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            placeholder="∞"
          />
        </label>
        <label>
          Max $ per turn
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={maxBudgetUsd}
            onChange={(e) => setMaxBudget(e.target.value)}
            placeholder="∞"
          />
        </label>
      </div>
      <button type="submit" className="primary" disabled={busy || !workdir}>
        {busy ? 'Hiring…' : 'Hire'}
      </button>
    </form>
  );
}
