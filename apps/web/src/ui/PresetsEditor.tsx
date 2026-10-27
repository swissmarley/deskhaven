import type { RolePreset, RolePresetListItem } from '@deskhaven/shared';
import { type JSX, useCallback, useEffect, useState } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';

const TEMPLATE: Omit<RolePreset, 'id'> = {
  name: 'New role',
  description: 'What this role does.',
  systemPrompt: 'You are …',
  tools: ['Read', 'Grep', 'Glob', 'LS'],
  allowedTools: ['Read', 'Grep', 'Glob', 'LS'],
  permissionMode: 'default',
};

/** Role presets are plain JSON documents; this editor edits them as such. */
export function PresetsEditor(): JSX.Element {
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [presets, setPresets] = useState<RolePresetListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [newId, setNewId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api
      .presets()
      .then((p) => setPresets(p))
      .catch((err) => pushNotice('error', String(err)));
  }, [pushNotice]);

  useEffect(() => load(), [load]);

  const open = (p: RolePresetListItem) => {
    setSelected(p.id);
    const { id: _id, ...rest } = p;
    setText(JSON.stringify(rest, null, 2));
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(text) as unknown;
      await api.savePreset(selected, parsed);
      pushNotice('info', `Preset “${selected}” saved`);
      load();
    } catch (err) {
      pushNotice(
        'error',
        err instanceof SyntaxError
          ? `Invalid JSON: ${err.message}`
          : String(err instanceof Error ? err.message : err),
      );
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.resetPreset(selected);
      pushNotice(
        'info',
        r.preset
          ? `Preset “${selected}” restored to its shipped definition`
          : `Preset “${selected}” removed`,
      );
      setSelected(null);
      load();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const id = newId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    if (!id) return;
    setSelected(id);
    setText(JSON.stringify(TEMPLATE, null, 2));
    setNewId('');
  };

  return (
    <section className="card">
      <h4>Role presets</h4>
      <div className="row wrap">
        {presets.map((p) => (
          <button
            type="button"
            key={p.id}
            className={selected === p.id ? 'primary' : ''}
            onClick={() => open(p)}
          >
            {p.name}
            {p.builtinUpdatePending ? ' •' : ''}
          </button>
        ))}
      </div>
      <div className="row">
        <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="new-role-id" />
        <button type="button" onClick={create} disabled={!newId.trim()}>
          New preset
        </button>
      </div>
      {selected ? (
        <>
          {presets.find((p) => p.id === selected)?.builtinUpdatePending ? (
            <p className="warn small">
              Built-in updated – Reset to apply the shipped definition, or keep your edits. Agents
              already hired keep the system prompt copied at hire time; edit them individually or
              re-hire to pick up preset changes.
            </p>
          ) : null}
          <p className="muted small">
            Editing <code>{selected}</code>. Fields: name, description, systemPrompt, model?, tools
            (array or null = all), allowedTools, permissionMode (default | acceptEdits | plan |
            dontAsk), manager?.
          </p>
          <textarea
            className="mono"
            rows={14}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => void reset()}>
              Reset / remove
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
