import type { RolePreset } from './dto.js';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MANAGER_MODEL = 'claude-opus-5-5';

export const KNOWN_MODELS: { id: string; label: string }[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (default)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const KNOWN_MODEL_IDS = new Set(KNOWN_MODELS.map((m) => m.id));

export function isKnownModel(id: string): boolean {
  return KNOWN_MODEL_IDS.has(id);
}

export const UNKNOWN_MODEL_CODE = 'unknown_model';

/** Model id stored on a new agent when the hire form leaves Model on Default. */
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
  if (preset?.manager) return DEFAULT_MANAGER_MODEL;
  return DEFAULT_MODEL;
}
