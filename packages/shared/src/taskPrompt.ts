import type { Agent, RolePreset, Task } from './dto.js';
import { agentIsManagerRole } from './models.js';
import { presetById } from './presets.js';

/** Appended to implementation tasks (and the Engineer preset). Keep preset JSON in sync. */
export const TASK_SCOPE_RULE =
  'Change only what this task asks for. If you notice other improvements or bugs, do not fix them: list them under "Suggested follow-ups (not done)" in your summary.';

const EDIT_TOOL_PREFIXES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function allowsEditTool(name: string): boolean {
  return EDIT_TOOL_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}(`));
}

/**
 * Whether the agent session exposes file-edit tools (Bash is excluded; it is not a reliable edit signal).
 * `tools: null` means the full Claude Code surface.
 */
export function agentCanEdit(tools: string[] | null): boolean {
  if (tools === null) return true;
  return tools.some(allowsEditTool);
}

export type PresetLookup = (id: string) => RolePreset | undefined;

function usesReviewTaskStyle(
  assignee: Pick<Agent, 'tools' | 'rolePresetId'>,
  preset: RolePreset | undefined,
): boolean {
  if (preset?.taskStyle) return preset.taskStyle === 'review';
  return !agentCanEdit(assignee.tools);
}

function summaryFormat(readOnlyOrReview: boolean): string {
  if (readOnlyOrReview) {
    return [
      'When you are done, end with a short summary with these sections:',
      '- **Findings**',
      '- **Out-of-scope changes (not asked for by the task)** (write "None" if none)',
      '- **Verdict**',
    ].join('\n');
  }
  return [
    TASK_SCOPE_RULE,
    '',
    'When you are done, end with a short summary with these sections:',
    '- **Changed**',
    '- **How to verify**',
    '- **Suggested follow-ups (not done)** (write "None" if you have nothing to suggest)',
  ].join('\n');
}

/** Closing instructions for a dispatched task; the format block is always last in the full prompt. */
export function taskTail(
  task: Task,
  assignee?: Pick<Agent, 'tools' | 'allowedTools' | 'permissionMode' | 'rolePresetId'> | null,
  presetLookup: PresetLookup = presetById,
): string {
  const preset = assignee ? presetLookup(assignee.rolePresetId) : undefined;
  const isManager = assignee ? agentIsManagerRole(assignee, preset) : false;
  const reviewStyle =
    Boolean(task.reviewTarget) ||
    (!isManager &&
      assignee !== null &&
      assignee !== undefined &&
      usesReviewTaskStyle(assignee, preset));
  return summaryFormat(reviewStyle);
}
