import { type JSX, useState } from 'react';
import {
  getMasterVolume,
  isSoundEnabled,
  playSound,
  SOUND_KINDS,
  SOUND_LABELS,
  type SoundKind,
  setMasterVolume,
  setSoundEnabled,
  unlockAudio,
} from '../game/index.js';

/** Per-sound toggles and master volume; preferences persist in localStorage via the sound module. */
export function SoundSettings(): JSX.Element {
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);
  return (
    <section className="card">
      <h4>Sounds</h4>
      <label>
        Master volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={getMasterVolume()}
          onChange={(e) => {
            unlockAudio();
            setMasterVolume(Number(e.target.value));
            refresh();
          }}
        />
      </label>
      <div className="sound-grid">
        {SOUND_KINDS.map((kind: SoundKind) => (
          <label key={kind} className="inline">
            <input
              type="checkbox"
              checked={isSoundEnabled(kind)}
              onChange={(e) => {
                setSoundEnabled(kind, e.target.checked);
                refresh();
              }}
            />
            {SOUND_LABELS[kind]}
            <button
              type="button"
              className="link"
              onClick={() => {
                unlockAudio();
                playSound(kind);
              }}
            >
              test
            </button>
          </label>
        ))}
      </div>
    </section>
  );
}
