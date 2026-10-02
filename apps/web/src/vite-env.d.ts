/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which world renderer to load: 'pixi' (default until G3) or 'three'. */
  readonly VITE_RENDERER?: 'pixi' | 'three';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
