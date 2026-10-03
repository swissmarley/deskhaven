import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDERER, resolveRendererKind } from '../src/game/renderer.js';

describe('resolveRendererKind', () => {
  it('defaults to three (the G3 parity flip)', () => {
    expect(DEFAULT_RENDERER).toBe('three');
    expect(resolveRendererKind(null, undefined)).toBe('three');
    expect(resolveRendererKind(undefined, undefined)).toBe('three');
    expect(resolveRendererKind('', '')).toBe('three');
    expect(resolveRendererKind('nope', 'webgpu')).toBe('three');
  });

  it('uses the build-time env when nothing valid is stored', () => {
    expect(resolveRendererKind(null, 'pixi')).toBe('pixi');
    expect(resolveRendererKind('nope', 'pixi')).toBe('pixi');
    expect(resolveRendererKind(null, 'three')).toBe('three');
    expect(resolveRendererKind(null, 'webgpu')).toBe('three');
  });

  it('prefers a valid stored override', () => {
    expect(resolveRendererKind('three', 'pixi')).toBe('three');
    expect(resolveRendererKind('pixi', 'three')).toBe('pixi');
    expect(resolveRendererKind('pixi', undefined)).toBe('pixi');
    expect(resolveRendererKind('THREE', 'pixi')).toBe('pixi');
  });
});
