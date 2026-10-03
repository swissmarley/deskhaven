import {
  canPlace,
  FURNITURE_CATALOG,
  type FurnitureKind,
  FurnitureKindSchema,
  furnitureAt,
  moveFurniture,
  paintFloor,
  paintWall,
  placeFurniture,
  type Room,
  removeFurniture,
  rotateFurniture,
  validateRoom,
} from '@deskhaven/shared';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { getWorldHandle } from './worldHandle.js';

export type EditorTool =
  | { kind: 'select' }
  | { kind: 'place'; piece: FurnitureKind }
  | { kind: 'floor'; style: number }
  | { kind: 'wall'; style: number }
  | { kind: 'erase' };

const FLOOR_STYLES = [
  { id: 0, label: 'Checker' },
  { id: 1, label: 'Rug' },
  { id: 2, label: 'Dark' },
  { id: 3, label: 'Wood' },
  { id: 4, label: 'Grass' },
];
const WALL_STYLES = [
  { id: 0, label: 'Plaster' },
  { id: 1, label: 'Brick' },
  { id: 2, label: 'Light' },
];

/**
 * Room editor. All edits run through the pure functions in shared on a local draft; the draft is pushed to
 * the world immediately (preview) and saved to the server with a short debounce. Server broadcasts
 * `room_updated`, which is what every other client sees.
 */
export function EditorPanel(): JSX.Element {
  const serverRoom = useAppStore((s) => Object.values(s.rooms)[0]);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [draft, setDraft] = useState<Room | null>(null);
  const [tool, setTool] = useState<EditorTool>({ kind: 'select' });
  const [rotation, setRotation] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const toolRef = useRef(tool);
  const rotationRef = useRef(rotation);
  const draftRef = useRef(draft);
  const selectedRef = useRef(selected);
  toolRef.current = tool;
  rotationRef.current = rotation;
  draftRef.current = draft;
  selectedRef.current = selected;

  // Start from the server's layout; re-sync when the server changes it and we have no local edits.
  useEffect(() => {
    if (serverRoom && (!draft || !dirty)) setDraft(serverRoom);
  }, [serverRoom, draft, dirty]);

  const apply = useCallback((next: Room) => {
    setDraft(next);
    setDirty(true);
    setError(null);
    getWorldHandle()?.setRoom(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const problems = validateRoom(next);
      if (problems.length) {
        setError(problems[0] ?? 'invalid layout');
        return;
      }
      api
        .saveRoom(next)
        .then(() => setDirty(false))
        .catch((err) => setError(String(err instanceof Error ? err.message : err)));
    }, 600);
  }, []);

  const fail = useCallback((message: string) => setError(message), []);

  // Wire the world's editor events while this panel is mounted.
  useEffect(() => {
    const world = getWorldHandle();
    if (!world) return;
    world.setEditorMode(true);
    world.setEvents({
      onAvatarClick: (id) => useAppStore.getState().selectAgent(id),
      onTileHover: (tile) => {
        const d = draftRef.current;
        const t = toolRef.current;
        if (!d || !tile || t.kind !== 'place') {
          world.setGhost(null);
          return;
        }
        world.setGhost({
          kind: t.piece,
          x: tile.x,
          y: tile.y,
          rotation: rotationRef.current,
          valid: canPlace(d, t.piece, tile.x, tile.y, rotationRef.current).ok,
        });
      },
      onTileClick: (tile) => {
        const d = draftRef.current;
        if (!d) return;
        const t = toolRef.current;
        switch (t.kind) {
          case 'place': {
            const r = placeFurniture(d, t.piece, tile.x, tile.y, rotationRef.current);
            r.ok ? apply(r.room) : fail(r.error);
            break;
          }
          case 'floor': {
            const r = paintFloor(d, tile.x, tile.y, t.style);
            if (r.ok) apply(r.room);
            break;
          }
          case 'wall': {
            // north wall when clicking the top row, west wall when clicking the left column
            const idx = tile.y === 0 ? tile.x : tile.x === 0 ? d.width + tile.y : -1;
            if (idx < 0) {
              fail('click a tile along the top row (north wall) or the left column (west wall)');
              break;
            }
            const r = paintWall(d, idx, t.style);
            if (r.ok) apply(r.room);
            break;
          }
          case 'erase': {
            const f = furnitureAt(d, tile.x, tile.y);
            if (f) {
              const r = removeFurniture(d, f.id);
              if (r.ok) apply(r.room);
            }
            break;
          }
          case 'select': {
            const f = furnitureAt(d, tile.x, tile.y);
            setSelected(f?.id ?? null);
            world.setHighlight(f ? { furnitureId: f.id } : null);
            break;
          }
        }
      },
      onTileDrag: (tile) => {
        const d = draftRef.current;
        const t = toolRef.current;
        if (!d || t.kind !== 'floor') return;
        const r = paintFloor(d, tile.x, tile.y, t.style);
        if (r.ok && r.room.floor[tile.y * d.width + tile.x] !== d.floor[tile.y * d.width + tile.x])
          apply(r.room);
      },
      onFurnitureClick: (id) => {
        if (toolRef.current.kind === 'erase') {
          const d = draftRef.current;
          if (!d) return;
          const r = removeFurniture(d, id);
          if (r.ok) apply(r.room);
          return;
        }
        setSelected(id);
        world.setHighlight({ furnitureId: id });
      },
      onFurnitureDragEnd: (id, tile) => {
        const d = draftRef.current;
        if (!d) return;
        const r = moveFurniture(d, id, tile.x, tile.y);
        r.ok ? apply(r.room) : fail(r.error);
      },
      onEditorKey: (key) => {
        const d = draftRef.current;
        if (key === 'Escape') {
          setTool({ kind: 'select' });
          setSelected(null);
          world.setGhost(null);
          world.setHighlight(null);
          return;
        }
        if (key === 'r' || key === 'R') {
          if (toolRef.current.kind === 'place') setRotation((v) => (v + 1) % 4);
          else if (d && selectedRef.current) {
            const r = rotateFurniture(d, selectedRef.current);
            r.ok ? apply(r.room) : fail(r.error);
          }
          return;
        }
        if ((key === 'Delete' || key === 'Backspace') && d && selectedRef.current) {
          const r = removeFurniture(d, selectedRef.current);
          if (r.ok) {
            apply(r.room);
            setSelected(null);
            world.setHighlight(null);
          }
        }
      },
    });
    return () => {
      world.setEditorMode(false);
      world.setGhost(null);
      world.setHighlight(null);
      // GameCanvas re-installs the default handlers when the editor closes.
      window.dispatchEvent(new CustomEvent('deskhaven:editor-closed'));
    };
  }, [apply, fail]);

  const selectedPiece = draft?.furniture.find((f) => f.id === selected);

  const reset = async () => {
    if (!confirm('Restore the shipped lobby layout? Your edits will be lost.')) return;
    try {
      const room = await api.resetRoom(draft?.id ?? 'lobby');
      setDraft(room);
      setDirty(false);
      getWorldHandle()?.setRoom(room);
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    }
  };

  const exportJson = () => {
    if (!draft) return;
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.id}-layout.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Room;
      const next = { ...parsed, id: draft?.id ?? parsed.id };
      const problems = validateRoom(next);
      if (problems.length) throw new Error(problems.join('; '));
      apply(next);
    } catch (err) {
      pushNotice('error', `Import failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  if (!draft) return <p className="muted">Loading room…</p>;

  return (
    <div className="panel editor">
      <div className="panel-head">
        <h3>Room editor</h3>
        <span className={`pill ${dirty ? 'warn' : ''}`}>{dirty ? 'saving…' : 'saved'}</span>
      </div>
      <p className="muted small">
        Click to place or paint, drag furniture to move it, <kbd>R</kbd> rotates, <kbd>Delete</kbd>{' '}
        removes, <kbd>Esc</kbd> back to select. {draft.width}×{draft.height} tiles.
      </p>
      {error ? <p className="error small">{error}</p> : null}
      <div className="toolbox">
        <button
          type="button"
          className={tool.kind === 'select' ? 'primary' : ''}
          onClick={() => setTool({ kind: 'select' })}
        >
          Select
        </button>
        <button
          type="button"
          className={tool.kind === 'erase' ? 'primary' : ''}
          onClick={() => setTool({ kind: 'erase' })}
        >
          Erase
        </button>
        <button
          type="button"
          onClick={() => setRotation((v) => (v + 1) % 4)}
          title="Rotation for new pieces"
        >
          Rotate ↻ {rotation * 90}°
        </button>
      </div>
      <h4>Furniture</h4>
      <div className="toolbox">
        {FurnitureKindSchema.options.map((k) => (
          <button
            type="button"
            key={k}
            className={tool.kind === 'place' && tool.piece === k ? 'primary' : ''}
            onClick={() => setTool({ kind: 'place', piece: k })}
          >
            <span
              className="swatch"
              style={{ background: `#${FURNITURE_CATALOG[k].color.toString(16).padStart(6, '0')}` }}
            />{' '}
            {FURNITURE_CATALOG[k].label}
          </button>
        ))}
      </div>
      <h4>Floor</h4>
      <div className="toolbox">
        {FLOOR_STYLES.map((f) => (
          <button
            type="button"
            key={f.id}
            className={tool.kind === 'floor' && tool.style === f.id ? 'primary' : ''}
            onClick={() => setTool({ kind: 'floor', style: f.id })}
          >
            {f.label}
          </button>
        ))}
      </div>
      <h4>Walls</h4>
      <div className="toolbox">
        {WALL_STYLES.map((w) => (
          <button
            type="button"
            key={w.id}
            className={tool.kind === 'wall' && tool.style === w.id ? 'primary' : ''}
            onClick={() => setTool({ kind: 'wall', style: w.id })}
          >
            {w.label}
          </button>
        ))}
      </div>
      {selectedPiece ? (
        <section className="card">
          <h4>
            {FURNITURE_CATALOG[selectedPiece.kind].label}{' '}
            <span className="muted mono small">{selectedPiece.id}</span>
          </h4>
          <p className="muted small">
            at {selectedPiece.x},{selectedPiece.y} · rotation {selectedPiece.rotation * 90}° ·
            station {FURNITURE_CATALOG[selectedPiece.kind].station ?? 'none'}
          </p>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                const r = rotateFurniture(draft, selectedPiece.id);
                r.ok ? apply(r.room) : fail(r.error);
              }}
            >
              Rotate
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                const r = removeFurniture(draft, selectedPiece.id);
                if (r.ok) {
                  apply(r.room);
                  setSelected(null);
                  getWorldHandle()?.setHighlight(null);
                }
              }}
            >
              Remove
            </button>
          </div>
        </section>
      ) : null}
      <h4>Layout</h4>
      <div className="row wrap">
        <button type="button" onClick={exportJson}>
          Export JSON
        </button>
        <label className="inline">
          <span className="button-like">Import JSON</span>
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])}
          />
        </label>
        <button type="button" className="danger" onClick={() => void reset()}>
          Reset to default
        </button>
      </div>
    </div>
  );
}
