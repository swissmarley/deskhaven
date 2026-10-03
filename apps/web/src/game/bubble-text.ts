import { truncate } from '@agenthotel/shared';
import type { BubbleKind } from './types.js';

/**
 * Bubble text and timing rules shared by the Pixi bubble (`pixi/bubble.ts`) and the Three DOM
 * overlay (`three/overlay.ts`), so both renderers show the same text for the same `say()`. Pure.
 */

/** Widest a bubble box gets, in CSS / stage pixels at zoom 1. */
export const BUBBLE_MAX_WIDTH = 180;
export const BUBBLE_PAD_X = 8;
export const BUBBLE_PAD_Y = 5;
export const BUBBLE_TAIL = 7;
/** Pop-in duration and the fade-out over the last part of the bubble's life. */
export const BUBBLE_POP_MS = 120;
export const BUBBLE_FADE_MS = 250;

export interface BubbleTheme {
  bg: number;
  fg: number;
  border: number;
  mono: boolean;
  bold: boolean;
}

export const BUBBLE_THEMES: Record<BubbleKind, BubbleTheme> = {
  speech: { bg: 0xffffff, fg: 0x1f2328, border: 0x8a8f98, mono: false, bold: false },
  thought: { bg: 0xeef1f5, fg: 0x5b6470, border: 0xb3bac4, mono: false, bold: false },
  alert: { bg: 0xd62828, fg: 0xffffff, border: 0x7a0f0f, mono: false, bold: true },
  code: { bg: 0x1b1f24, fg: 0xa6e3a1, border: 0x3b4048, mono: true, bold: false },
};

/** Characters kept before the ellipsis: alerts are short, everything else 80. */
export function bubbleMaxChars(kind: BubbleKind): number {
  return kind === 'alert' ? 40 : 80;
}

/** The text a bubble shows: whitespace collapsed, truncated per kind, never empty. */
export function bubbleText(raw: string, kind: BubbleKind): string {
  return truncate(raw, bubbleMaxChars(kind)) || ' ';
}

/** Font size and line height per kind (code is monospace and a point smaller). */
export function bubbleFont(kind: BubbleKind): { size: number; lineHeight: number } {
  return BUBBLE_THEMES[kind].mono ? { size: 10, lineHeight: 13 } : { size: 11, lineHeight: 14 };
}

/**
 * Scale and alpha of a bubble `ageMs` after it appeared with `remainingMs` left: pops from 0.6 to 1
 * with an ease-out over `BUBBLE_POP_MS`, then fades over the last `BUBBLE_FADE_MS`.
 */
export function bubblePop(ageMs: number, remainingMs: number): { scale: number; alpha: number } {
  const pop = Math.min(1, Math.max(0, ageMs) / BUBBLE_POP_MS);
  const scale = 0.6 + 0.4 * (1 - (1 - pop) * (1 - pop));
  const alpha = Math.min(1, Math.max(0, remainingMs) / BUBBLE_FADE_MS);
  return { scale, alpha };
}
