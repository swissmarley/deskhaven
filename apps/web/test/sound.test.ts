import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createThrottleState,
  DEFAULT_MASTER_VOLUME,
  defaultPrefs,
  getMasterVolume,
  getSoundPrefs,
  isSoundEnabled,
  MAX_VOICES,
  markPlayed,
  parsePrefs,
  playSound,
  pruneVoices,
  reloadSoundPrefs,
  SOUND_KINDS,
  SOUND_LABELS,
  SOUND_STORAGE_KEY,
  type SoundKind,
  serializePrefs,
  setMasterVolume,
  setSoundEnabled,
  shouldPlay,
  THROTTLE_MS,
  unlockAudio,
} from '../src/game/sound.js';

/** Map-backed stand-in for `window.localStorage`. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

/**
 * Just enough of the WebAudio graph for `playSound` to schedule a motif: every node accepts
 * connections and every AudioParam accepts ramps; started sources are counted.
 */
function fakeAudio() {
  let started = 0;
  let instances = 0;
  let last: FakeContext | null = null;
  const param = () => ({
    value: 0,
    setValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
  });
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  class FakeContext {
    state = 'running';
    currentTime = 0;
    sampleRate = 48000;
    destination = node();
    constructor() {
      instances++;
      last = this;
    }
    resume(): Promise<void> {
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() {
      return { ...node(), gain: param() };
    }
    createBiquadFilter() {
      return { ...node(), type: 'lowpass', frequency: param(), Q: param() };
    }
    createOscillator() {
      return {
        ...node(),
        type: 'sine',
        frequency: param(),
        onended: null,
        start: () => {
          started++;
        },
        stop: () => undefined,
      };
    }
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    createBufferSource() {
      return {
        ...node(),
        buffer: null,
        loop: false,
        onended: null,
        start: () => {
          started++;
        },
        stop: () => undefined,
      };
    }
  }
  return {
    Ctor: FakeContext,
    started: () => started,
    instances: () => instances,
    last: () => last,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reloadSoundPrefs();
});

describe('sound catalogue', () => {
  it('labels every kind', () => {
    expect(SOUND_KINDS.length).toBe(9);
    for (const k of SOUND_KINDS) expect(SOUND_LABELS[k].length).toBeGreaterThan(0);
    expect(Object.keys(SOUND_LABELS).sort()).toEqual([...SOUND_KINDS].sort());
  });
});

describe('prefs (pure)', () => {
  it('defaults to everything on at the default volume', () => {
    const p = defaultPrefs();
    for (const k of SOUND_KINDS) expect(p.enabled[k]).toBe(true);
    expect(p.volume).toBe(DEFAULT_MASTER_VOLUME);
  });

  it('parses null, garbage and non-objects as defaults', () => {
    for (const bad of [null, undefined, '', 'not json', '42', '"str"', '[]', 'null']) {
      expect(parsePrefs(bad)).toEqual(defaultPrefs());
    }
  });

  it('round-trips through serializePrefs', () => {
    const p = defaultPrefs();
    p.enabled.typing = false;
    p.enabled.click = false;
    p.volume = 0.25;
    const back = parsePrefs(serializePrefs(p));
    expect(back).toEqual(p);
    expect(JSON.parse(serializePrefs(p))).toEqual({ enabled: p.enabled, volume: 0.25 });
  });

  it('drops unknown kinds, ignores non-boolean flags and clamps the volume', () => {
    const p = parsePrefs(
      JSON.stringify({
        enabled: { typing: false, bogus: false, done: 'no', error: 0 },
        volume: 1.7,
      }),
    );
    expect(p.enabled.typing).toBe(false);
    expect(p.enabled.done).toBe(true);
    expect(p.enabled.error).toBe(true);
    expect('bogus' in p.enabled).toBe(false);
    expect(p.volume).toBe(1);
    expect(parsePrefs(JSON.stringify({ volume: -3 })).volume).toBe(0);
    expect(parsePrefs(JSON.stringify({ volume: 'loud' })).volume).toBe(DEFAULT_MASTER_VOLUME);
    expect(parsePrefs(JSON.stringify({ enabled: 'all' })).enabled).toEqual(defaultPrefs().enabled);
  });

  it('serialises missing flags as enabled and clamps the volume', () => {
    const partial = { enabled: { typing: false }, volume: 9 } as unknown as ReturnType<
      typeof defaultPrefs
    >;
    const out = JSON.parse(serializePrefs(partial)) as {
      enabled: Record<string, boolean>;
      volume: number;
    };
    expect(out.volume).toBe(1);
    expect(out.enabled.typing).toBe(false);
    expect(out.enabled.done).toBe(true);
    expect(Object.keys(out.enabled).length).toBe(SOUND_KINDS.length);
  });
});

describe('throttling and voice cap (pure)', () => {
  it('throttles typing to one play per 300 ms and nothing else', () => {
    expect(THROTTLE_MS.typing).toBe(300);
    const st = createThrottleState();
    expect(shouldPlay('typing', 1000, st)).toBe(true);
    markPlayed('typing', 1000, st);
    expect(shouldPlay('typing', 1100, st)).toBe(false);
    expect(shouldPlay('typing', 1299, st)).toBe(false);
    expect(shouldPlay('typing', 1300, st)).toBe(true);
    // shouldPlay never mutates: asking twice gives the same answer.
    expect(shouldPlay('typing', 1100, st)).toBe(false);
    const others = SOUND_KINDS.filter((k): k is Exclude<SoundKind, 'typing'> => k !== 'typing');
    for (const k of others) {
      markPlayed(k, 1000, st);
      expect(shouldPlay(k, 1000, st)).toBe(true);
    }
  });

  it('keeps only voices that end in the future', () => {
    expect(pruneVoices([0.5, 1.0, 2.0], 1.0)).toEqual([2.0]);
    expect(pruneVoices([], 3)).toEqual([]);
    expect(MAX_VOICES).toBeGreaterThan(0);
  });
});

describe('persistence', () => {
  it('writes toggles and volume under agenthotel.sound and reads them back', () => {
    const store = new MemoryStorage();
    vi.stubGlobal('localStorage', store);
    reloadSoundPrefs();
    expect(isSoundEnabled('typing')).toBe(true);
    setSoundEnabled('typing', false);
    setMasterVolume(0.25);
    expect(isSoundEnabled('typing')).toBe(false);
    expect(getMasterVolume()).toBe(0.25);
    const raw = store.getItem(SOUND_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(parsePrefs(raw)).toEqual({
      ...defaultPrefs(),
      enabled: { ...defaultPrefs().enabled, typing: false },
      volume: 0.25,
    });
    // A fresh load picks the stored values up again.
    const again = reloadSoundPrefs();
    expect(again.enabled.typing).toBe(false);
    expect(again.volume).toBe(0.25);
    // Snapshot is a copy.
    const snap = getSoundPrefs();
    snap.enabled.done = false;
    expect(isSoundEnabled('done')).toBe(true);
  });

  it('clamps the master volume and skips redundant writes', () => {
    const store = new MemoryStorage();
    const spy = vi.spyOn(store, 'setItem');
    vi.stubGlobal('localStorage', store);
    reloadSoundPrefs();
    setMasterVolume(5);
    expect(getMasterVolume()).toBe(1);
    setMasterVolume(1);
    setMasterVolume(Number.NaN);
    expect(getMasterVolume()).toBe(0);
    setSoundEnabled('done', true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('survives a storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => reloadSoundPrefs()).not.toThrow();
    expect(isSoundEnabled('done')).toBe(true);
    expect(() => setSoundEnabled('done', false)).not.toThrow();
    expect(isSoundEnabled('done')).toBe(false);
  });
});

describe('playSound', () => {
  it('is a no-op without an AudioContext (Node)', () => {
    expect(typeof (globalThis as { AudioContext?: unknown }).AudioContext).toBe('undefined');
    for (const k of SOUND_KINDS) expect(() => playSound(k)).not.toThrow();
    expect(() => playSound('done', { volume: 2 })).not.toThrow();
    expect(() => unlockAudio()).not.toThrow();
  });

  it('schedules every motif, honours the voice cap and the typing throttle with a fake context', async () => {
    const fake = fakeAudio();
    vi.stubGlobal('AudioContext', fake.Ctor);
    vi.stubGlobal('localStorage', new MemoryStorage());
    let now = 0;
    vi.stubGlobal('performance', { now: () => now });
    vi.resetModules();
    const mod = await import('../src/game/sound.js');
    mod.reloadSoundPrefs();
    // Each motif starts at least one source and never throws.
    for (const k of mod.SOUND_KINDS) {
      const before = fake.started();
      mod.playSound(k);
      expect(fake.started()).toBeGreaterThan(before);
      now += 1000;
      // Advance the audio clock too so finished voices are pruned.
      const ac = fake.last();
      if (ac) ac.currentTime = now / 1000;
    }
    expect(fake.instances()).toBe(1);
    // Voice cap: hold the audio clock so no voice expires; a burst of 20 keeps at most MAX_VOICES.
    const held = fake.last();
    if (held) held.currentTime = 20;
    const base = fake.started();
    for (let i = 0; i < 20; i++) {
      mod.playSound('done');
      now += 1000;
    }
    const perDone = 4; // four arpeggio notes
    expect(fake.started() - base).toBe(perDone * mod.MAX_VOICES);
    // Typing throttle: two plays within 300 ms schedule only once.
    vi.resetModules();
    const fresh = fakeAudio();
    vi.stubGlobal('AudioContext', fresh.Ctor);
    const mod2 = await import('../src/game/sound.js');
    mod2.reloadSoundPrefs();
    now = 5000;
    mod2.playSound('typing');
    const afterFirst = fresh.started();
    expect(afterFirst).toBeGreaterThan(0);
    now = 5100;
    mod2.playSound('typing');
    expect(fresh.started()).toBe(afterFirst);
    now = 5300;
    mod2.playSound('typing');
    expect(fresh.started()).toBeGreaterThan(afterFirst);
    // Disabled kinds and zero volume are silent.
    const before = fresh.started();
    mod2.setSoundEnabled('done', false);
    mod2.playSound('done');
    mod2.setSoundEnabled('done', true);
    mod2.setMasterVolume(0);
    mod2.playSound('done');
    expect(fresh.started()).toBe(before);
    mod2.setMasterVolume(1);
    mod2.playSound('done', { volume: 0 });
    expect(fresh.started()).toBe(before);
  });
});
