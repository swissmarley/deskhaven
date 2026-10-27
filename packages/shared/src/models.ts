import type { RolePreset } from './dto.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_MANAGER_MODEL = 'claude-opus-5-5';

export const KNOWN_MODELS: { id: string; label: string }[] = [
  { id: DEFAULT_MODEL, label: 'Claude Sonnet 5.5 (default)' },
  { id: DEFAULT_MANAGER_MODEL, label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const KNOWN_MODEL_IDS = new Set(KNOWN_MODELS.map((m) => m.id));

export function isKnownModel(id: string): boolean {
  return KNOWN_MODEL_IDS.has(id);
}

export const UNKNOWN_MODEL_CODE = 'unknown_model';

/** Whether hire-time / session fallbacks should treat this agent as a manager role. */
export function agentIsManagerRole(
  agent: { rolePresetId: string },
  preset: RolePreset | undefined,
): boolean {
  if (preset?.manager) return true;
  // Built-in manager id when the preset row is missing (e.g. rare DB loss).
  return !preset && agent.rolePresetId === 'manager';
}

/**
 * Model id stored on a new agent when the hire form leaves Model on Default.
 * Custom presets with `manager: true` always follow Settings → Manager model; any `model` field on
 * the preset JSON is ignored (same as the built-in Manager).
 */
export function resolveAgentModel(
  explicit: string | undefined,
  preset: RolePreset,
  settings: { defaultModel: string; managerModel: string },
): string {
  if (explicit !== undefined) return explicit;
  if (preset.manager) return settings.managerModel;
  return preset.model ?? settings.defaultModel;
}

/**
 * Model passed to the SDK. Uses the persisted agent model; legacy blank rows fall back to
 * built-in defaults (not live Settings) so changing defaults does not retarget existing agents.
 */
export function sessionModel(
  agent: { model: string; rolePresetId: string },
  preset: RolePreset | undefined,
): string {
  const trimmed = agent.model.trim();
  if (trimmed) return trimmed;
  if (agentIsManagerRole(agent, preset)) return DEFAULT_MANAGER_MODEL;
  return DEFAULT_MODEL;
}
