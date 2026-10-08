import {
  type Agent,
  type Avatar,
  agentCwd,
  type CreateAgent,
  type PermissionMode,
  type RolePreset,
  type UpdateAgent,
} from '@deskhaven/shared';
import { type JSX, useEffect, useState } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { AvatarPicker, randomAvatar } from './AvatarPicker.js';

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Ask (default)' },
  { id: 'acceptEdits', label: 'Accept edits, ask for the rest' },
  { id: 'plan', label: 'Plan only (no execution)' },
  { id: 'dontAsk', label: "Don't ask: deny anything not pre-approved" },
];

interface Props {
  /** When set, the form edits this agent instead of creating one. */
  agent?: Agent;
  initialWorkdir?: string;
  onDone: () => void;
}

/** Shared create / edit form for the HR desk. */
export function AgentForm({ agent, initialWorkdir, onDone }: Props): JSX.Element {
  const pushNotice = useAppStore((s) => s.pushNotice);
  const settings = useAppStore((s) => s.settings);
  const rooms = useAppStore((s) => s.rooms);
  const agents = useAppStore((s) => s.agents);
  const [presets, setPresets] = useState<RolePreset[]>([]);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [name, setName] = useState(agent?.name ?? '');
  const [avatar, setAvatar] = useState<Avatar>(agent?.avatar ?? randomAvatar());
  const [rolePresetId, setRole] = useState(agent?.rolePresetId ?? 'engineer');
  const [workdir, setWorkdir] = useState(agent?.workdir ?? initialWorkdir ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>(
    agent?.permissionMode ?? '',
  );
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [allowedTools, setAllowedTools] = useState(agent?.allowedTools.join(', ') ?? '');
  const [tools, setTools] = useState(agent?.tools?.join(', ') ?? '');
  const [maxTurns, setMaxTurns] = useState(
    agent?.budget.maxTurns ? String(agent.budget.maxTurns) : '',
  );
  const [maxBudgetUsd, setMaxBudget] = useState(
    agent?.budget.maxBudgetUsd ? String(agent.budget.maxBudgetUsd) : '',
  );
  const [dailyCapUsd, setDailyCap] = useState(
    agent?.budget.dailyCapUsd ? String(agent.budget.dailyCapUsd) : '',
  );
  const [deskId, setDeskId] = useState(agent?.deskId ?? '');
  const [useWorktree, setUseWorktree] = useState(false);
  const [advanced, setAdvanced] = useState(Boolean(agent));
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
  const room = Object.values(rooms)[0];
  const desks = room?.furniture.filter((f) => f.kind === 'desk') ?? [];
  const deskOwner = (id: string) =>
    Object.values(agents).find((a) => a.deskId === id && a.id !== agent?.id)?.name;

  // Switching the role on a new agent resets the role-derived fields to the preset defaults.
  const applyPreset = (id: string) => {
    setRole(id);
    if (!agent) {
      setSystemPrompt('');
      setAllowedTools('');
      setTools('');
      setPermissionMode('');
    }
  };

  const list = (s: string): string[] =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = async () => {
    setBusy(true);
    try {
      const budget: Agent['budget'] = {};
      if (maxTurns) budget.maxTurns = Number(maxTurns);
      if (maxBudgetUsd) budget.maxBudgetUsd = Number(maxBudgetUsd);
      if (dailyCapUsd) budget.dailyCapUsd = Number(dailyCapUsd);
      if (agent) {
        const patch: UpdateAgent = {
          name: name || agent.name,
          avatar,
          rolePresetId,
          workdir,
          model: model || agent.model,
          permissionMode: permissionMode || agent.permissionMode,
          systemPrompt,
          allowedTools: list(allowedTools),
          tools: tools.trim() ? list(tools) : null,
          budget,
          deskId: deskId || null,
        };
        await api.updateAgent(agent.id, patch);
      } else {
        const input: CreateAgent = {
          name: name || `${preset?.name ?? 'Agent'} ${Math.floor(Math.random() * 90 + 10)}`,
          avatar,
          rolePresetId,
          workdir,
          budget,
          useWorktree,
          ...(model ? { model } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(systemPrompt.trim() ? { systemPrompt } : {}),
          ...(allowedTools.trim() ? { allowedTools: list(allowedTools) } : {}),
          ...(tools.trim() ? { tools: list(tools) } : {}),
        };
        await api.createAgent(input);
      }
      onDone();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const prepareSample = async () => {
    try {
      setWorkdir((await api.sampleInit()).path);
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
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
      <AvatarPicker value={avatar} onChange={setAvatar} />
      <label>
        Role
        <select value={rolePresetId} onChange={(e) => applyPreset(e.target.value)}>
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
      {!agent ? (
        <div className="row">
          <button type="button" onClick={() => void prepareSample()}>
            Use the sample repo
          </button>
          <label
            className="inline"
            title="Give this agent its own git worktree and branch (repo must be git)"
          >
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
            />{' '}
            git worktree
          </label>
        </div>
      ) : agent.worktree ? (
        <p className="muted small">
          Worktree: {agentCwd(agent)} ({agent.worktree.branch})
        </p>
      ) : null}
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
      <button type="button" className="link" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? 'Hide advanced' : 'Advanced: system prompt, tools, budgets, desk'}
      </button>
      {advanced ? (
        <>
          <label>
            System prompt (appended to the Claude Code preset)
            <textarea
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={preset?.systemPrompt ?? ''}
            />
          </label>
          <label>
            Allowed tools (auto-approved, comma separated)
            <input
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder={preset?.allowedTools.join(', ') ?? ''}
            />
          </label>
          <label>
            Available tools (comma separated; empty = preset's set
            {preset?.tools ? '' : ', all tools'})
            <input
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder={preset?.tools?.join(', ') ?? 'all Claude Code tools'}
            />
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
              Max $ / turn
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={maxBudgetUsd}
                onChange={(e) => setMaxBudget(e.target.value)}
                placeholder="∞"
              />
            </label>
            <label>
              Max $ / day
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={dailyCapUsd}
                onChange={(e) => setDailyCap(e.target.value)}
                placeholder="∞"
              />
            </label>
          </div>
          {agent ? (
            <label>
              Desk
              <select value={deskId} onChange={(e) => setDeskId(e.target.value)}>
                <option value="">No desk</option>
                {desks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id}
                    {deskOwner(d.id) ? ` (taken by ${deskOwner(d.id)})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      <button type="submit" className="primary" disabled={busy || !workdir}>
        {busy ? 'Saving…' : agent ? 'Save' : 'Hire'}
      </button>
    </form>
  );
}
