import { describe, expect, it } from 'vitest';
import { resolveRendererKind } from '../src/game/renderer.js';

describe('resolveRendererKind', () => {
  it('defaults to pixi', () => {
    expect(resolveRendererKind(null, undefined)).toBe('pixi');
    expect(resolveRendererKind(undefined, undefined)).toBe('pixi');
    expect(resolveRendererKind('', '')).toBe('pixi');
  });

  it('uses the build-time env when nothing valid is stored', () => {
    expect(resolveRendererKind(null, 'three')).toBe('three');
    expect(resolveRendererKind('nope', 'three')).toBe('three');
    expect(resolveRendererKind(null, 'webgpu')).toBe('pixi');
  });

  it('prefers a valid stored override', () => {
    expect(resolveRendererKind('three', 'pixi')).toBe('three');
    expect(resolveRendererKind('pixi', 'three')).toBe('pixi');
    expect(resolveRendererKind('THREE', 'pixi')).toBe('pixi');
  });
});
