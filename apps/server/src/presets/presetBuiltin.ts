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

/** Engineer built-in with task-scope discipline and the full tool set (main @ 31.10.2026). */
export const ENGINEER_PRESET_FULL_TOOLS: RolePreset = RolePresetSchema.parse({
  id: 'engineer',
  name: 'Engineer',
  description:
    'Implements changes. Edits are auto-approved inside the workdir; shell commands ask first.',
  systemPrompt:
    'You are an Engineer. Implement the task end to end inside your working directory: read the relevant code first, make focused edits, and keep the code style of the repository. Change only what this task asks for. If you notice other improvements or bugs, do not fix them: list them under "Suggested follow-ups (not done)" in your summary. When you finish, end with a short summary with sections Changed, How to verify, and Suggested follow-ups (not done). Ask for permission before running shell commands; prefer running the project\'s own test command.',
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
export const ENGINEER_PRESET_FULL_TOOLS_HASH = hashRolePreset(ENGINEER_PRESET_FULL_TOOLS);
export const MANAGER_PRESET_MAIN_HASH = hashRolePreset(MANAGER_PRESET_MAIN);

/**
 * Shipped revisions that still listed the retired `LS` tool (main @ 84a99da, 31.10.2026), as
 * `hashRolePreset` of the parsed preset. A DB row that still matches one is updated in place.
 */
const WITH_LS_HASH = {
  architect: 'a2c2a41ea79492fc2e0ec5360ae26e32948f1dc470b519e6a492c573073705ec',
  manager: '28fc197ee45c81a9cf8fc2515e92fa7edecfb9615aafa2916cf95ac78d09dbf7',
  qa: 'a897e6aed6392be3982d902b7086edbf2058bdfec68d1a7934e96014de0ac8fc',
  researcher: 'd094ec1cf64b5ae6807833d6eaa2fa7384b2f379fb9e6b0e34a99bb3ae6e3855',
  reviewer: '8989d6fcd9f14174c344d2fc7f1710e9e299161838c210621f957651713b218b',
} as const;

/** Prior shipped hashes per built-in id; auto-migrate when the DB row still matches one of them. */
export const BUILTIN_PRESET_LEGACY_HASH: Record<string, readonly string[]> = {
  engineer: [ENGINEER_PRESET_LEGACY_HASH, ENGINEER_PRESET_FULL_TOOLS_HASH],
  manager: [MANAGER_PRESET_MAIN_HASH, WITH_LS_HASH.manager],
  architect: [WITH_LS_HASH.architect],
  qa: [WITH_LS_HASH.qa],
  researcher: [WITH_LS_HASH.researcher],
  reviewer: [WITH_LS_HASH.reviewer],
};
