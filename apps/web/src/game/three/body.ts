import type { Avatar } from '@deskhaven/shared';
import type { Object3D, Vector3 } from 'three';
import type { Pose } from '../pose.js';

/**
 * What `AvatarMeshes` needs from a body: the G1b capsule (`CapsuleBody`, the placeholder and the
 * fallback when the GLB fails) and the rigged character (`CharacterRig`) both implement it. The
 * owner handles position, yaw, the intern/poof scale, the hit volume, the highlight ring, the
 * emotes and the leave fade timer; the body handles its own look and animation. All lengths are
 * world units at scale 1 (the body group's scale carries the intern factor).
 */
export interface AvatarBody {
  /** Added under the avatar's body group; must not be reparented by the body. */
  readonly object: Object3D;
  /** Standing hit-volume size: radius and height of a cylinder from the feet. */
  readonly hitRadius: number;
  readonly hitHeight: number;
  /** Where the body goes when seated: shift along the facing (local +Z) and vertical offset. */
  readonly seatForward: number;
  readonly seatLift: number;

  setAppearance(avatar: Avatar, isIntern: boolean): void;
  setPose(pose: Pose): void;
  setSeated(seated: boolean): void;
  /** Overall scale applied by the owner (interns 0.8), for anything speed-dependent. */
  setScale(scale: number): void;
  /** 1 is opaque; anything below makes the materials transparent (leave fade). */
  setOpacity(opacity: number): void;
  /** Faint blue cast while rate-limited (`cooldown`), off again for every other pose. */
  setTint(on: boolean): void;
  /** World position of the top of the head this frame (labels, bubbles and emotes hang off it). */
  headTop(out: Vector3): Vector3;
  update(dt: number): void;
  dispose(): void;
}
