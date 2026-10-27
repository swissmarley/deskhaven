import { describe, expect, it } from 'vitest';
import { agentModelPatchForEdit, legacyModelOption } from '../src/ui/agentModelPatch.js';

describe('agentModelPatch', () => {
  it('omits model when the legacy value is unchanged', () => {
    expect(agentModelPatchForEdit('claude-sonnet-4-5', 'claude-sonnet-4-5')).toEqual({});
  });

  it('sends null when clearing to Default', () => {
    expect(agentModelPatchForEdit('claude-haiku-5-5', '')).toEqual({ model: null });
  });

  it('flags legacy catalog ids for the select', () => {
    const catalog = new Set(['claude-sonnet-5-5']);
    expect(legacyModelOption('claude-sonnet-4-5', catalog)).toBe('claude-sonnet-4-5');
    expect(legacyModelOption('claude-sonnet-5-5', catalog)).toBeNull();
  });
});
