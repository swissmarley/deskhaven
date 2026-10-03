import type { Avatar } from '@deskhaven/shared';
import { type JSX, useEffect, useState } from 'react';
import { renderAvatarPreview3d } from '../game/preview.js';
import { rendererKind } from '../game/renderer.js';

const SKINS = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#a1665e'];
const HAIRS = [
  '#1b1b1b',
  '#2c1b18',
  '#4a2c2a',
  '#b55239',
  '#d6b370',
  '#6e6e6e',
  '#3a86ff',
  '#ef476f',
  '#06d6a0',
];
const SHIRTS = [
  '#3a86ff',
  '#ff006e',
  '#8338ec',
  '#fb5607',
  '#06d6a0',
  '#ffbe0b',
  '#118ab2',
  '#ef476f',
  '#edf2f4',
];
const PANTS = ['#1d3557', '#2b2d42', '#4a4e69', '#22223b', '#5c677d', '#6c584c', '#1b1b1b'];
const HAIR_STYLES: Avatar['hairStyle'][] = ['short', 'long', 'cap', 'bald', 'bun'];
const ACCESSORIES: Avatar['accessory'][] = ['none', 'glasses', 'headset', 'tie', 'scarf'];

export function randomAvatar(): Avatar {
  const pick = <T,>(arr: readonly T[]): T =>
    arr[Math.floor(Math.random() * arr.length)] ?? (arr[0] as T);
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle: pick(HAIR_STYLES),
    shirt: pick(SHIRTS),
    pants: pick(PANTS),
    accessory: pick(ACCESSORIES),
  };
}

type PreviewFn = (avatar: Avatar, facing?: 0 | 1 | 2 | 3, scale?: number) => string;

export interface AvatarPreviewImage {
  url: string;
  /** True for the pixel sprite (rendered with `image-rendering: pixelated`), false for the 3D render. */
  pixelated: boolean;
}

/**
 * Renders the avatar preview lazily. With the Three renderer active it asks the offscreen 3D preview
 * first (`game/preview.js`, the only allowed import path: a lazy wrapper that loads Three on demand) and falls back to
 * the procedural pixel sprite (`game/sprites.js`, no renderer) when WebGL or the model is unavailable;
 * with the Pixi renderer the pixel sprite is used directly. Null while nothing is ready.
 */
export function useAvatarPreview(
  avatar: Avatar,
  facing: 0 | 1 | 2 | 3 = 2,
): AvatarPreviewImage | null {
  const [image, setImage] = useState<AvatarPreviewImage | null>(null);
  const key = JSON.stringify(avatar);
  useEffect(() => {
    let cancelled = false;
    const parsed = JSON.parse(key) as Avatar;
    const pixel = async (): Promise<void> => {
      const mod = (await import('../game/sprites.js')) as unknown as {
        renderAvatarPreview?: PreviewFn;
      };
      if (cancelled || !mod.renderAvatarPreview) return;
      try {
        setImage({ url: mod.renderAvatarPreview(parsed, facing, 4), pixelated: true });
      } catch {
        setImage(null);
      }
    };
    const run = async (): Promise<void> => {
      if (rendererKind() === 'three') {
        try {
          const url = await renderAvatarPreview3d(parsed, { size: 144, facing });
          if (cancelled) return;
          if (url) {
            setImage({ url, pixelated: false });
            return;
          }
        } catch {
          // Fall through to the pixel sprite.
        }
      }
      await pixel();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [key, facing]);
  return image;
}

export function AvatarPreview({
  avatar,
  size = 64,
}: {
  avatar: Avatar;
  size?: number;
}): JSX.Element {
  const image = useAvatarPreview(avatar);
  if (image)
    return (
      <img
        src={image.url}
        alt="avatar preview"
        width={size}
        height={size}
        style={{ imageRendering: image.pixelated ? 'pixelated' : 'auto', objectFit: 'contain' }}
      />
    );
  return (
    <span className="avatar-fallback" style={{ width: size, height: size }}>
      <span style={{ background: avatar.hair }} />
      <span style={{ background: avatar.skin }} />
      <span style={{ background: avatar.shirt }} />
      <span style={{ background: avatar.pants }} />
    </span>
  );
}

export function AvatarPicker({
  value,
  onChange,
}: {
  value: Avatar;
  onChange: (a: Avatar) => void;
}): JSX.Element {
  const Swatches = ({
    label,
    options,
    field,
  }: {
    label: string;
    options: string[];
    field: 'skin' | 'hair' | 'shirt' | 'pants';
  }) => (
    <div className="swatch-row">
      <span className="swatch-label">{label}</span>
      {options.map((c) => (
        <button
          type="button"
          key={c}
          className={`swatch-btn ${value[field] === c ? 'active' : ''}`}
          style={{ background: c }}
          title={c}
          onClick={() => onChange({ ...value, [field]: c })}
        />
      ))}
    </div>
  );
  return (
    <div className="avatar-picker">
      <div className="avatar-picker-top">
        <AvatarPreview avatar={value} size={72} />
        <button type="button" onClick={() => onChange(randomAvatar())}>
          Shuffle
        </button>
      </div>
      <Swatches label="Skin" options={SKINS} field="skin" />
      <Swatches label="Hair" options={HAIRS} field="hair" />
      <Swatches label="Shirt" options={SHIRTS} field="shirt" />
      <Swatches label="Pants" options={PANTS} field="pants" />
      <div className="row">
        <label>
          Hair style
          <select
            value={value.hairStyle}
            onChange={(e) =>
              onChange({ ...value, hairStyle: e.target.value as Avatar['hairStyle'] })
            }
          >
            {HAIR_STYLES.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label>
          Accessory
          <select
            value={value.accessory}
            onChange={(e) =>
              onChange({ ...value, accessory: e.target.value as Avatar['accessory'] })
            }
          >
            {ACCESSORIES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
