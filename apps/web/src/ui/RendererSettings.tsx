import { type JSX, useState } from 'react';
import {
  RENDERER_STORAGE_KEY,
  type RendererKind,
  rendererKind,
  resolveRendererKind,
} from '../game/index.js';

type Choice = RendererKind | 'default';

/** The renderer this page actually loaded: read once, before any Settings change. */
const ACTIVE_RENDERER: RendererKind = rendererKind();

function storedChoice(): Choice {
  try {
    const v = localStorage.getItem(RENDERER_STORAGE_KEY);
    return v === 'pixi' || v === 'three' ? v : 'default';
  } catch {
    return 'default';
  }
}

/**
 * Picks the world renderer. The world is created once per page, so a change takes effect after a
 * reload; the choice lives in localStorage and overrides the build-time `VITE_RENDERER` default.
 */
export function RendererSettings(): JSX.Element {
  const [choice, setChoice] = useState<Choice>(storedChoice);
  const active = ACTIVE_RENDERER;
  const pending =
    (choice === 'default' ? resolveRendererKind(null, import.meta.env.VITE_RENDERER) : choice) !==
    active;

  const change = (next: Choice): void => {
    try {
      if (next === 'default') localStorage.removeItem(RENDERER_STORAGE_KEY);
      else localStorage.setItem(RENDERER_STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the select still reflects the choice for this page.
    }
    setChoice(next);
  };

  return (
    <section className="card">
      <h4>Renderer</h4>
      <label>
        World renderer (active: {active})
        <select value={choice} onChange={(e) => change(e.target.value as Choice)}>
          <option value="default">Build default</option>
          <option value="pixi">Pixel art (PixiJS)</option>
          <option value="three">3D (Three.js)</option>
        </select>
      </label>
      {pending ? (
        <p className="muted">
          Takes effect after a reload.{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Reload now
          </button>
        </p>
      ) : null}
    </section>
  );
}
