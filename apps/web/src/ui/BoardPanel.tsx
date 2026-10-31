import type { Task, TaskStatus } from '@deskhaven/shared';
import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { type JSX, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { AvatarPreview } from './AvatarPicker.js';
import { fmtUsd } from './eventText.js';
import { plainTextFromMarkdown } from './markdownPlain.js';
import { reviewerCanWrite } from './merge.js';
import { TaskDetail } from './TaskDetail.js';
import { getWorldHandle } from './worldHandle.js';

export const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'needs_input', label: 'Needs input' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

/** A drag shorter than this is a click: no column or avatar is that close to where it started. */
export const CLICK_SLOP_PX = 12;

export function isClickDrag(delta: { x: number; y: number }): boolean {
  return Math.hypot(delta.x, delta.y) < CLICK_SLOP_PX;
}

const selectTasks = (s: { tasks: Record<string, Task> }) =>
  Object.values(s.tasks).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);

/** Kanban drawer. Cards drag between columns, or onto an avatar in the room to assign the task. */
export function BoardPanel(): JSX.Element {
  const tasks = useAppStore(useShallow(selectTasks));
  const agents = useAppStore((s) => s.agents);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [creating, setCreating] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragMove = (e: DragMoveEvent) => {
    const world = getWorldHandle();
    const rect = e.active.rect.current.translated;
    if (!world || !rect) return;
    const tile = world.screenToTile(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const avatarId = tile ? world.getAvatarAt(tile) : null;
    world.setHighlight(avatarId ? { avatarId } : tile ? { tile } : null);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const world = getWorldHandle();
    world?.setHighlight(null);
    const taskId = String(e.active.id);
    // A click with a slightly shaky hand or trackpad crosses the 6 px activation distance and becomes
    // a tiny drag, which swallows the click: treat it as the click it was meant to be.
    if (isClickDrag(e.delta)) {
      setOpenTask(taskId);
      return;
    }
    try {
      if (e.over) {
        const status = String(e.over.id) as TaskStatus;
        const task = tasks.find((t) => t.id === taskId);
        if (task && task.status !== status) await api.updateTask(taskId, { status });
        return;
      }
      const rect = e.active.rect.current.translated;
      if (!world || !rect) return;
      const tile = world.screenToTile(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const avatarId = tile ? world.getAvatarAt(tile) : null;
      if (avatarId && agents[avatarId]) await api.assignTask(taskId, avatarId);
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <section className="board">
      <div className="board-head">
        <h3>Task board</h3>
        <span className="muted small">drag a card onto an avatar to assign it</span>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Close' : 'New task'}
        </button>
      </div>
      {creating ? <CreateTaskForm onDone={() => setCreating(false)} /> : null}
      <DndContext sensors={sensors} onDragMove={onDragMove} onDragEnd={(e) => void onDragEnd(e)}>
        <div className="columns">
          {COLUMNS.map((c) => (
            <Column
              key={c.id}
              id={c.id}
              label={c.label}
              tasks={tasks.filter((t) => t.status === c.id)}
              onOpen={setOpenTask}
            />
          ))}
        </div>
      </DndContext>
      {openTask ? <TaskDetail taskId={openTask} onClose={() => setOpenTask(null)} /> : null}
    </section>
  );
}

function Column({
  id,
  label,
  tasks,
  onOpen,
}: {
  id: TaskStatus;
  label: string;
  tasks: Task[];
  onOpen: (id: string) => void;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`column ${isOver ? 'over' : ''} col-${id}`}>
      <div className="column-head">
        {label} <span className="muted">{tasks.length}</span>
      </div>
      <div className="column-cards">
        {tasks.map((t) => (
          <Card key={t.id} task={t} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function Card({ task, onOpen }: { task: Task; onOpen: (id: string) => void }): JSX.Element {
  const agent = useAppStore((s) =>
    task.assigneeAgentId ? s.agents[task.assigneeAgentId] : undefined,
  );
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 20 }
    : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit's attributes give the card role="button" and tabIndex 0
    <div
      ref={setNodeRef}
      style={style}
      className={`card-task ${isDragging ? 'dragging' : ''}`}
      {...listeners}
      {...attributes}
      // The whole card opens the task, so a card scrolled half out of view is still one click away.
      // A drag needs 6 px of movement first (PointerSensor), so a click never starts one.
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(task.id);
        }
      }}
    >
      <button
        type="button"
        className="card-title"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(task.id);
        }}
      >
        {task.title}
      </button>
      <div className="card-meta">
        {agent ? (
          <span className="assignee">
            <AvatarPreview avatar={agent.avatar} size={18} /> {agent.name}
          </span>
        ) : task.assigneeAgentId ? (
          <span className="muted">unknown agent</span>
        ) : (
          <span className="muted">unassigned</span>
        )}
        {task.costUsd ? <span className="muted">{fmtUsd(task.costUsd)}</span> : null}
        {task.filesChanged.length ? (
          <span className="muted">{task.filesChanged.length} files</span>
        ) : null}
        {task.merge?.status === 'merged' && task.merge.commit ? (
          <span className="pill ok">merged {task.merge.commit.slice(0, 7)}</span>
        ) : null}
      </div>
      {task.resultSummary &&
      (task.status === 'review' || task.status === 'done' || task.status === 'needs_input') ? (
        <p className="card-summary">{plainTextFromMarkdown(task.resultSummary).slice(0, 140)}</p>
      ) : null}
    </div>
  );
}

function CreateTaskForm({ onDone }: { onDone: () => void }): JSX.Element {
  const agents = useAppStore(useShallow((s) => Object.values(s.agents)));
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [assignee, setAssignee] = useState('');
  const [reviewOf, setReviewOf] = useState('');
  const [busy, setBusy] = useState(false);
  const reviewer = agents.find((a) => a.id === assignee);
  const subjectOptions = agents.filter((a) => a.id !== assignee);
  const submit = async () => {
    setBusy(true);
    try {
      await api.createTask({
        title,
        prompt,
        assigneeAgentId: assignee || null,
        reviewOfAgentId: reviewOf || null,
      });
      onDone();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form task-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4 className="task-form-title">New task</h4>
      <div className="row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          required
        />
        <select
          value={assignee}
          onChange={(e) => {
            const next = e.target.value;
            setAssignee(next);
            if (reviewOf === next) setReviewOf('');
          }}
        >
          <option value="">Backlog (unassigned)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.rolePresetId}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="primary"
          disabled={busy || !title.trim() || !prompt.trim()}
        >
          {assignee ? 'Create & assign' : 'Create'}
        </button>
      </div>
      <textarea
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the agent do? This becomes the prompt."
        required
      />
      <label className="small">
        Review work of{' '}
        <select value={reviewOf} onChange={(e) => setReviewOf(e.target.value)}>
          <option value="">None</option>
          {subjectOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.rolePresetId}
            </option>
          ))}
        </select>
      </label>
      {reviewOf && reviewerCanWrite(reviewer) ? (
        <p className="small warn-text">
          This assignee can edit or run tools. A read-only reviewer is the usual choice. The review
          still cannot write the other checkout.
        </p>
      ) : null}
    </form>
  );
}
