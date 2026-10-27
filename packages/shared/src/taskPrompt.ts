import type { RolePreset, Task } from './dto.js';

/** Appended to implementation tasks (and the Engineer preset). Keep preset JSON in sync. */
export const TASK_SCOPE_RULE =
  'Change only what this task asks for. If you notice other improvements or bugs, do not fix them: list them under "Suggested follow-ups (not done)" in your summary.';

const EDIT_TOOL_PREFIXES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** True when the preset cannot edit repository files (Reviewer, QA, Architect, …). */
export function presetIsReadOnly(preset: RolePreset): boolean {
  return !preset.allowedTools.some((t) =>
    EDIT_TOOL_PREFIXES.some((prefix) => t === prefix || t.startsWith(`${prefix}(`)),
  );
}

function summaryFormat(readOnlyOrReview: boolean): string {
  if (readOnlyOrReview) {
    return [
      'When you are done, end with a short summary with these sections:',
      '- **Findings**',
      '- **Out-of-scope**',
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
export function taskTail(task: Task, assigneePreset?: RolePreset): string {
  const readOnlyOrReview =
    Boolean(task.reviewTarget) || (assigneePreset && presetIsReadOnly(assigneePreset));
  return summaryFormat(Boolean(readOnlyOrReview));
}
