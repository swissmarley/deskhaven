/** Minimal WebAudio beeps for the UI (the game's richer sound set arrives in M7). */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function beep(kind: 'alert' | 'ok' | 'error'): void {
  const ac = audio();
  if (!ac) return;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.connect(g);
  g.connect(ac.destination);
  const t = ac.currentTime;
  const [f1, f2, dur] =
    kind === 'alert' ? [880, 1320, 0.18] : kind === 'ok' ? [660, 990, 0.12] : [220, 160, 0.25];
  o.type = 'square';
  o.frequency.setValueAtTime(f1, t);
  o.frequency.linearRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t);
  o.stop(t + dur + 0.02);
}
