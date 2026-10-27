import { describe, expect, it } from 'vitest';
import type { RolePreset } from '../src/dto.js';
import {
  agentIsManagerRole,
  isKnownModel,
  resolveAgentModel,
  sessionModel,
} from '../src/models.js';
import manager from '../src/presets/manager.json';

describe('models', () => {
  it('recognises shipped model ids', () => {
    expect(isKnownModel('claude-haiku-5-5')).toBe(true);
    expect(isKnownModel('pippo')).toBe(false);
  });

  it('resolves hire defaults with manager settings ahead of preset.model', () => {
    const preset = manager as RolePreset;
    expect(preset.model).toBeUndefined();
    expect(
      resolveAgentModel(undefined, preset, {
        defaultModel: 'claude-sonnet-5-5',
        managerModel: 'claude-haiku-5-5',
      }),
    ).toBe('claude-haiku-5-5');
    expect(
      resolveAgentModel('claude-opus-5-5', preset, {
        defaultModel: 'claude-sonnet-5-5',
        managerModel: 'claude-haiku-5-5',
      }),
    ).toBe('claude-opus-5-5');
  });

  it('ignores preset.model on custom manager presets when hiring on Default', () => {
    const cto: RolePreset = {
      id: 'cto',
      name: 'CTO',
      description: 'Custom manager',
      systemPrompt: 'delegate',
      model: 'claude-sonnet-5-5',
      tools: ['Read'],
      allowedTools: ['Read'],
      permissionMode: 'default',
      manager: true,
    };
    expect(
      resolveAgentModel(undefined, cto, {
        defaultModel: 'claude-sonnet-5-5',
        managerModel: 'claude-haiku-5-5',
      }),
    ).toBe('claude-haiku-5-5');
  });

  it('sessionModel ignores live settings for blank persisted models', () => {
    const preset = manager as RolePreset;
    expect(sessionModel({ model: '', rolePresetId: 'manager' }, preset)).toBe('claude-opus-5-5');
    expect(sessionModel({ model: 'claude-haiku-5-5', rolePresetId: 'manager' }, preset)).toBe(
      'claude-haiku-5-5',
    );
  });

  it('sessionModel treats custom manager presets and legacy manager ids as managers', () => {
    const cto: RolePreset = {
      id: 'cto',
      name: 'CTO',
      description: 'Custom manager',
      systemPrompt: 'delegate',
      tools: ['Read'],
      allowedTools: ['Read'],
      permissionMode: 'default',
      manager: true,
    };
    expect(agentIsManagerRole({ rolePresetId: 'cto' }, cto)).toBe(true);
    expect(sessionModel({ model: '', rolePresetId: 'cto' }, cto)).toBe('claude-opus-5-5');
    expect(sessionModel({ model: '', rolePresetId: 'manager' }, undefined)).toBe('claude-opus-5-5');
    expect(sessionModel({ model: '', rolePresetId: 'engineer' }, undefined)).toBe(
      'claude-sonnet-5-5',
    );
  });
});
