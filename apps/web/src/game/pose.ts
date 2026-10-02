import type { Behavior } from '@agenthotel/shared';

/**
 * Visual poses an avatar can show. Behaviours map onto these through `poseFor`; `coffee` is the
 * idle coffee-sip variant and `walk` is set by the movement system. Pure data, no renderer.
 */
export type Pose =
  | 'idle'
  | 'walk'
  | 'typing'
  | 'working'
  | 'reading'
  | 'terminal'
  | 'browsing'
  | 'thinking'
  | 'raise_hand'
  | 'sweat'
  | 'cooldown'
  | 'celebrate'
  | 'nap'
  | 'wait'
  | 'leave'
  | 'coffee';

/** The pose an avatar plays once it stands where a behaviour wants it. */
export function poseFor(b: Behavior): Pose {
  switch (b.kind) {
    case 'idle':
      return b.variant === 'coffee' ? 'coffee' : 'idle';
    case 'thinking':
      return 'thinking';
    case 'reading':
      return 'reading';
    case 'typing':
      return 'typing';
    case 'terminal':
      return 'terminal';
    case 'browsing':
      return 'browsing';
    case 'delegating':
    case 'working':
      return 'working';
    case 'raise_hand':
      return 'raise_hand';
    case 'sweat':
      return 'sweat';
    case 'cooldown':
      return 'cooldown';
    case 'celebrate':
      return 'celebrate';
    case 'nap':
      return 'nap';
    case 'wait':
      return 'wait';
    case 'leave':
      return 'leave';
  }
}
