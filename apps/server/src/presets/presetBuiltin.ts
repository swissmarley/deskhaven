import { createHash } from 'node:crypto';
import { type RolePreset, RolePresetSchema } from '@deskhaven/shared';

/** Stable hash of a preset document (full JSON object as stored in SQLite). */
export function hashRolePreset(preset: RolePreset): string {
  return createHash('sha256').update(JSON.stringify(preset)).digest('hex');
}

/** Engineer built-in shipped before task-scope discipline (main @ 27.10.2026). */
export const ENGINEER_PRESET_LEGACY: RolePreset = RolePresetSchema.parse({
  id: 'engineer',
  name: 'Engineer',
  description:
    'Implements changes. Edits are auto-approved inside the workdir; shell commands ask first.',
  systemPrompt:
    "You are an Engineer. Implement the task end to end inside your working directory: read the relevant code first, make focused edits, keep the code style of the repository, and finish with a short summary of what changed and how to verify it. Ask for permission before running shell commands; prefer running the project's own test command.",
  tools: null,
  allowedTools: [
    'Read',
    'Grep',
    'Glob',
    'LS',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'TodoWrite',
  ],
  permissionMode: 'default',
});

/** Manager built-in on main before PR #4 model/settings changes (hash pinned for migration). */
export const MANAGER_PRESET_MAIN: RolePreset = RolePresetSchema.parse({
  id: 'manager',
  name: 'Manager',
  description:
    'Breaks a goal into tasks and delegates them to employees through the task board. Never edits code.',
  systemPrompt:
    'You are the Manager of this office. When given a goal, first inspect the repository briefly, then break the goal into small, independent tasks with clear acceptance criteria and create them with the task tools, assigning each to the most suitable employee (list them first). Delegation is flat: you never do the implementation yourself and never create another manager. Track progress with task_status and summarise results when the work is done.',
  model: 'claude-opus-5-5',
  tools: [
    'Read',
    'Grep',
    'Glob',
    'LS',
    'TodoWrite',
    'mcp__deskhaven__list_agents',
    'mcp__deskhaven__create_task',
    'mcp__deskhaven__assign_task',
    'mcp__deskhaven__task_status',
  ],
  allowedTools: [
    'Read',
    'Grep',
    'Glob',
    'LS',
    'TodoWrite',
    'mcp__deskhaven__list_agents',
    'mcp__deskhaven__create_task',
    'mcp__deskhaven__assign_task',
    'mcp__deskhaven__task_status',
  ],
  permissionMode: 'default',
  manager: true,
});

export const ENGINEER_PRESET_LEGACY_HASH = hashRolePreset(ENGINEER_PRESET_LEGACY);
export const MANAGER_PRESET_MAIN_HASH = hashRolePreset(MANAGER_PRESET_MAIN);

/** Prior shipped hashes per built-in id; auto-migrate when the DB row still matches one of them. */
export const BUILTIN_PRESET_LEGACY_HASH: Record<string, readonly string[]> = {
  engineer: [ENGINEER_PRESET_LEGACY_HASH],
  manager: [MANAGER_PRESET_MAIN_HASH],
};
