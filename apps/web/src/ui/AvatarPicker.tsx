import type { Avatar } from '@agenthotel/shared';
import { type JSX, useEffect, useState } from 'react';

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

/** Loads the sprite preview renderer lazily; falls back to a colour swatch while sprites are not available. */
export function useAvatarPreview(avatar: Avatar, facing: 0 | 1 | 2 | 3 = 2): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = JSON.stringify(avatar);
  useEffect(() => {
    let cancelled = false;
    void import('../game/index.js').then((mod) => {
      const fn = (mod as unknown as { renderAvatarPreview?: PreviewFn }).renderAvatarPreview;
      if (!fn || cancelled) return;
      try {
        setUrl(fn(JSON.parse(key) as Avatar, facing, 4));
      } catch {
        setUrl(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, facing]);
  return url;
}

export function AvatarPreview({
  avatar,
  size = 64,
}: {
  avatar: Avatar;
  size?: number;
}): JSX.Element {
  const url = useAvatarPreview(avatar);
  if (url)
    return (
      <img
        src={url}
        alt="avatar preview"
        width={size}
        height={size}
        style={{ imageRendering: 'pixelated', objectFit: 'contain' }}
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
