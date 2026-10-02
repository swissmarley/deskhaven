import { type RolePreset, RolePresetSchema } from './dto.js';
import architect from './presets/architect.json';
import engineer from './presets/engineer.json';
import manager from './presets/manager.json';
import qa from './presets/qa.json';
import researcher from './presets/researcher.json';
import reviewer from './presets/reviewer.json';

export const BUILTIN_PRESETS: RolePreset[] = [
  architect,
  engineer,
  reviewer,
  researcher,
  qa,
  manager,
].map((p) => RolePresetSchema.parse(p));

export function presetById(id: string): RolePreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}
