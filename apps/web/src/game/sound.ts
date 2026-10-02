/**
 * Synthesised WebAudio sound set: short motifs (≤ 400 ms) built from oscillators and filtered
 * noise, no audio files. Preferences (per-sound toggles + master volume) persist in localStorage
 * under `agenthotel.sound`. Everything degrades to a no-op where WebAudio or storage is missing
 * (Node tests, SSR, locked-down browsers) and `playSound` never throws.
 *
 * The pure parts — preference (de)serialisation, throttling, the voice cap — are exported so they
 * can be unit-tested without an AudioContext.
 */

export type SoundKind =
  | 'tool_start'
  | 'typing'
  | 'permission'
  | 'done'
  | 'error'
  | 'rate_limit'
  | 'intern'
  | 'message'
  | 'click';

export const SOUND_KINDS: readonly SoundKind[] = [
  'tool_start',
  'typing',
  'permission',
  'done',
  'error',
  'rate_limit',
  'intern',
  'message',
  'click',
];

/** Human labels for a settings UI. */
export const SOUND_LABELS: Record<SoundKind, string> = {
  tool_start: 'Tool started',
  typing: 'Typing',
  permission: 'Permission needed',
  done: 'Turn finished',
  error: 'Error',
  rate_limit: 'Rate limit cooldown',
  intern: 'Intern arrives or leaves',
  message: 'Message',
  click: 'UI click',
};

export const SOUND_STORAGE_KEY = 'agenthotel.sound';
export const DEFAULT_MASTER_VOLUME = 0.7;
/** Simultaneous motifs; a burst of events beyond this is dropped rather than stacked. */
export const MAX_VOICES = 6;
/** Minimum gap between two plays of the same kind (ms). Unlisted kinds are never throttled. */
export const THROTTLE_MS: Partial<Record<SoundKind, number>> = { typing: 300 };
/** Overall output level at master volume 1 (motif gains are relative to this). */
const MASTER_GAIN = 0.3;

// ---- preferences (pure) ---------------------------------------------------------------------------

export interface SoundPrefs {
  enabled: Record<SoundKind, boolean>;
  /** Master volume, 0..1. */
  volume: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isSoundKind(k: string): k is SoundKind {
  return (SOUND_KINDS as readonly string[]).includes(k);
}

export function defaultPrefs(): SoundPrefs {
  const enabled = {} as Record<SoundKind, boolean>;
  for (const k of SOUND_KINDS) enabled[k] = true;
  return { enabled, volume: DEFAULT_MASTER_VOLUME };
}

/**
 * Tolerant parse of the persisted JSON: unknown kinds are dropped, missing or malformed flags
 * default to enabled, a bad volume falls back to the default. Never throws.
 */
export function parsePrefs(json: string | null | undefined): SoundPrefs {
  const prefs = defaultPrefs();
  if (!json) return prefs;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return prefs;
  }
  if (typeof raw !== 'object' || raw === null) return prefs;
  const obj = raw as { enabled?: unknown; volume?: unknown };
  if (typeof obj.enabled === 'object' && obj.enabled !== null) {
    for (const [k, v] of Object.entries(obj.enabled as Record<string, unknown>)) {
      if (isSoundKind(k) && typeof v === 'boolean') prefs.enabled[k] = v;
    }
  }
  if (typeof obj.volume === 'number' && Number.isFinite(obj.volume))
    prefs.volume = clamp01(obj.volume);
  return prefs;
}

export function serializePrefs(prefs: SoundPrefs): string {
  const enabled: Partial<Record<SoundKind, boolean>> = {};
  for (const k of SOUND_KINDS) enabled[k] = prefs.enabled[k] ?? true;
  return JSON.stringify({ enabled, volume: clamp01(prefs.volume) });
}

// ---- throttling and voice cap (pure) -----------------------------------------------------------------

export interface ThrottleState {
  /** Clock reading (ms) of the last accepted play per kind. */
  last: Partial<Record<SoundKind, number>>;
}

export function createThrottleState(): ThrottleState {
  return { last: {} };
}

/** True when `kind` may play at `now` given the last accepted play of that kind. Does not mutate. */
export function shouldPlay(kind: SoundKind, now: number, state: ThrottleState): boolean {
  const gap = THROTTLE_MS[kind];
  if (!gap) return true;
  const last = state.last[kind];
  return last === undefined || now - last >= gap;
}

export function markPlayed(kind: SoundKind, now: number, state: ThrottleState): void {
  state.last[kind] = now;
}

/** Voice end times still in the future (audio-clock seconds); the rest have finished. */
export function pruneVoices(ends: readonly number[], now: number): number[] {
  return ends.filter((end) => end > now);
}

// ---- persisted state --------------------------------------------------------------------------------

let prefs: SoundPrefs | null = null;
const throttle = createThrottleState();

function storage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

function loadPrefs(): SoundPrefs {
  let json: string | null = null;
  try {
    json = storage()?.getItem(SOUND_STORAGE_KEY) ?? null;
  } catch {
    json = null;
  }
  return parsePrefs(json);
}

function savePrefs(p: SoundPrefs): void {
  try {
    storage()?.setItem(SOUND_STORAGE_KEY, serializePrefs(p));
  } catch {
    // Storage full or blocked: preferences live for this session only.
  }
}

function current(): SoundPrefs {
  prefs ??= loadPrefs();
  return prefs;
}

/** Snapshot of every toggle plus the master volume (for a settings panel). */
export function getSoundPrefs(): SoundPrefs {
  const p = current();
  return { enabled: { ...p.enabled }, volume: p.volume };
}

/** Re-read preferences from storage (e.g. on a `storage` event from another tab). */
export function reloadSoundPrefs(): SoundPrefs {
  prefs = loadPrefs();
  return getSoundPrefs();
}

export function setSoundEnabled(kind: SoundKind, on: boolean): void {
  const p = current();
  if (p.enabled[kind] === on) return;
  p.enabled[kind] = on;
  savePrefs(p);
}

export function isSoundEnabled(kind: SoundKind): boolean {
  return current().enabled[kind] ?? true;
}

export function setMasterVolume(v: number): void {
  const p = current();
  const next = clamp01(v);
  if (p.volume === next) return;
  p.volume = next;
  savePrefs(p);
}

export function getMasterVolume(): number {
  return current().volume;
}

// ---- audio context ----------------------------------------------------------------------------------

type AudioContextCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let ctxUnavailable = false;
let noiseBuffer: AudioBuffer | null = null;
let voiceEnds: number[] = [];

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  if (ctxUnavailable) return null;
  const Ctor = audioContextCtor();
  if (!Ctor) {
    ctxUnavailable = true;
    return null;
  }
  try {
    ctx = new Ctor();
    return ctx;
  } catch {
    ctxUnavailable = true;
    return null;
  }
}

/**
 * Call from the first user gesture (pointerdown/keydown): creates the shared context if needed and
 * resumes it if the browser started it suspended. Safe to call repeatedly.
 */
export function unlockAudio(): void {
  try {
    const ac = context();
    if (ac && ac.state === 'suspended') void ac.resume().catch(() => {});
  } catch {
    // Nothing to unlock.
  }
}

function clockMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

// ---- synthesis helpers --------------------------------------------------------------------------------

interface Filter {
  type: BiquadFilterType;
  freq: number;
  q?: number;
}

interface ToneSpec {
  type: OscillatorType;
  /** Start frequency (Hz); `to` glides there over the note when set. */
  f: number;
  to?: number;
  at: number;
  dur: number;
  gain: number;
  attack?: number;
  filter?: Filter;
}

interface NoiseSpec {
  at: number;
  dur: number;
  gain: number;
  filter?: Filter;
}

const FLOOR = 0.0001;

function withFilter(ac: AudioContext, src: AudioNode, filter: Filter | undefined): AudioNode {
  if (!filter) return src;
  const f = ac.createBiquadFilter();
  f.type = filter.type;
  f.frequency.value = filter.freq;
  f.Q.value = filter.q ?? 0.9;
  src.connect(f);
  return f;
}

/** Schedules one enveloped note; returns the time its tail is over. */
function tone(ac: AudioContext, out: AudioNode, s: ToneSpec): number {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = s.type;
  osc.frequency.setValueAtTime(s.f, s.at);
  if (s.to !== undefined) osc.frequency.exponentialRampToValueAtTime(s.to, s.at + s.dur);
  const attack = s.attack ?? 0.008;
  g.gain.setValueAtTime(FLOOR, s.at);
  g.gain.exponentialRampToValueAtTime(s.gain, s.at + attack);
  g.gain.exponentialRampToValueAtTime(FLOOR, s.at + s.dur);
  withFilter(ac, osc, s.filter).connect(g);
  g.connect(out);
  const end = s.at + s.dur + 0.01;
  osc.start(s.at);
  osc.stop(end);
  osc.onended = () => g.disconnect();
  return end;
}

function makeNoise(ac: AudioContext): AudioBuffer {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Schedules a filtered white-noise burst with an exponential decay; returns its end time. */
function noise(ac: AudioContext, out: AudioNode, s: NoiseSpec): number {
  noiseBuffer ??= makeNoise(ac);
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const g = ac.createGain();
  g.gain.setValueAtTime(s.gain, s.at);
  g.gain.exponentialRampToValueAtTime(FLOOR, s.at + s.dur);
  withFilter(ac, src, s.filter).connect(g);
  g.connect(out);
  const end = s.at + s.dur + 0.01;
  src.start(s.at);
  src.stop(end);
  src.onended = () => g.disconnect();
  return end;
}

// ---- motifs --------------------------------------------------------------------------------------------

type Motif = (ac: AudioContext, out: AudioNode, t: number) => number;

const NOTE = {
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  B5: 987.77,
  C6: 1046.5,
  D6: 1174.66,
} as const;

const MOTIFS: Record<SoundKind, Motif> = {
  // Soft two-note blip.
  tool_start: (ac, out, t) => {
    tone(ac, out, { type: 'sine', f: 660, at: t, dur: 0.07, gain: 0.5 });
    return tone(ac, out, { type: 'sine', f: 880, at: t + 0.08, dur: 0.1, gain: 0.5 });
  },
  // Quiet keyboard click (throttled to one per 300 ms by `THROTTLE_MS`).
  typing: (ac, out, t) => {
    noise(ac, out, { at: t, dur: 0.02, gain: 0.3, filter: { type: 'highpass', freq: 3000 } });
    return tone(ac, out, {
      type: 'triangle',
      f: 1800,
      at: t,
      dur: 0.015,
      gain: 0.12,
      attack: 0.002,
    });
  },
  // Urgent three-note ascending chime.
  permission: (ac, out, t) => {
    tone(ac, out, { type: 'triangle', f: NOTE.G5, at: t, dur: 0.11, gain: 0.6 });
    tone(ac, out, { type: 'triangle', f: NOTE.B5, at: t + 0.1, dur: 0.11, gain: 0.6 });
    return tone(ac, out, { type: 'triangle', f: NOTE.D6, at: t + 0.2, dur: 0.14, gain: 0.65 });
  },
  // Pleasant major arpeggio (C–E–G–C).
  done: (ac, out, t) => {
    const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6];
    let end = t;
    notes.forEach((f, i) => {
      end = tone(ac, out, { type: 'sine', f, at: t + i * 0.065, dur: 0.14, gain: 0.45 });
    });
    return end;
  },
  // Low descending buzz.
  error: (ac, out, t) =>
    tone(ac, out, {
      type: 'sawtooth',
      f: 220,
      to: 110,
      at: t,
      dur: 0.3,
      gain: 0.35,
      attack: 0.015,
      filter: { type: 'lowpass', freq: 900 },
    }),
  // Slow two-tone "cooldown".
  rate_limit: (ac, out, t) => {
    tone(ac, out, { type: 'sine', f: 440, at: t, dur: 0.15, gain: 0.4, attack: 0.02 });
    return tone(ac, out, { type: 'sine', f: 330, at: t + 0.18, dur: 0.2, gain: 0.4, attack: 0.02 });
  },
  // Door knock: two muffled taps.
  intern: (ac, out, t) => {
    let end = t;
    for (const at of [t, t + 0.14]) {
      noise(ac, out, { at, dur: 0.05, gain: 0.6, filter: { type: 'lowpass', freq: 500 } });
      end = tone(ac, out, {
        type: 'sine',
        f: 120,
        to: 80,
        at,
        dur: 0.06,
        gain: 0.5,
        attack: 0.003,
      });
    }
    return end;
  },
  // Soft pop: a quick downward glide.
  message: (ac, out, t) =>
    tone(ac, out, { type: 'sine', f: 620, to: 380, at: t, dur: 0.09, gain: 0.45, attack: 0.004 }),
  // UI tick.
  click: (ac, out, t) => {
    noise(ac, out, { at: t, dur: 0.01, gain: 0.2, filter: { type: 'highpass', freq: 4000 } });
    return tone(ac, out, { type: 'square', f: 2200, at: t, dur: 0.012, gain: 0.1, attack: 0.001 });
  },
};

// ---- playback -------------------------------------------------------------------------------------------

/**
 * Play a motif. No-op when the kind is disabled, the master volume is 0, the kind is throttled,
 * WebAudio is unavailable or still suspended (call `unlockAudio` on a user gesture), or the voice
 * cap is reached. Never throws.
 */
export function playSound(kind: SoundKind, opts?: { volume?: number }): void {
  try {
    if (!isSoundEnabled(kind)) return;
    const level = clamp01(getMasterVolume()) * clamp01(opts?.volume ?? 1);
    if (level <= 0) return;
    const now = clockMs();
    if (!shouldPlay(kind, now, throttle)) return;
    const ac = context();
    if (!ac) return;
    if (ac.state !== 'running') {
      // Scheduling into a suspended context would replay the whole backlog on unlock.
      if (ac.state === 'suspended') void ac.resume().catch(() => {});
      return;
    }
    const t = ac.currentTime;
    voiceEnds = pruneVoices(voiceEnds, t);
    if (voiceEnds.length >= MAX_VOICES) return;
    markPlayed(kind, now, throttle);
    const out = ac.createGain();
    out.gain.value = MASTER_GAIN * level;
    out.connect(ac.destination);
    const end = MOTIFS[kind](ac, out, t);
    voiceEnds.push(end);
    setTimeout(
      () => {
        try {
          out.disconnect();
        } catch {
          // Already gone.
        }
      },
      Math.max(0, (end - t) * 1000) + 50,
    );
  } catch {
    // Sound is decoration; never let it break the caller.
  }
}
