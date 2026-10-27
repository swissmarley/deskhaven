import type { Agent, PermissionMode, RolePreset, Task } from './dto.js';
import { presetById } from './presets.js';

/** Appended to implementation tasks (and the Engineer preset). Keep preset JSON in sync. */
export const TASK_SCOPE_RULE =
  'Change only what this task asks for. If you notice other improvements or bugs, do not fix them: list them under "Suggested follow-ups (not done)" in your summary.';

const EDIT_TOOL_PREFIXES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function allowsEditTool(name: string): boolean {
  return EDIT_TOOL_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}(`));
}

/** Unrestricted shell access can change files even without explicit Edit tools. */
function isUnrestrictedBash(name: string): boolean {
  return name === 'Bash';
}

function toolGrantsEdit(name: string): boolean {
  return allowsEditTool(name) || isUnrestrictedBash(name);
}

/**
 * Whether the agent session exposes tools that can modify the workdir.
 * Uses `tools` only (`allowedTools` is auto-approval policy). `tools: null` means the full surface.
 */
export function agentCanEdit(
  tools: string[] | null,
  _allowedTools: string[],
  _permissionMode: PermissionMode,
): boolean {
  if (tools === null) return true;
  return tools.some(toolGrantsEdit);
}

export type PresetLookup = (id: string) => RolePreset | undefined;

/** True when the role preset (from DB or shipped) is marked as a manager. */
export function agentIsManagerRole(rolePresetId: string, lookup: PresetLookup): boolean {
  return lookup(rolePresetId)?.manager === true;
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
  const isManager = assignee ? agentIsManagerRole(assignee.rolePresetId, presetLookup) : false;
  const canEdit = assignee
    ? agentCanEdit(assignee.tools, assignee.allowedTools, assignee.permissionMode)
    : true;
  const reviewStyle = Boolean(task.reviewTarget) || (!isManager && Boolean(assignee) && !canEdit);
  return summaryFormat(reviewStyle);
}
