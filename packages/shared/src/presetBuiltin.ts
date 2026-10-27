import { createHash } from 'node:crypto';
import type { RolePreset } from './dto.js';
import { RolePresetSchema } from './dto.js';

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

export const ENGINEER_PRESET_LEGACY_HASH = hashRolePreset(ENGINEER_PRESET_LEGACY);

/** Built-in ids that may be auto-migrated when the DB still holds an unmodified legacy copy. */
export const BUILTIN_PRESET_LEGACY_HASH: Partial<Record<string, string>> = {
  engineer: ENGINEER_PRESET_LEGACY_HASH,
};
