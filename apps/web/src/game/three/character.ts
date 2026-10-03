import type { Avatar } from '@deskhaven/shared';
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  Euler,
  Group,
  LoopOnce,
  LoopRepeat,
  type Material,
  Mesh,
  type Object3D,
  Quaternion,
  SkinnedMesh,
  type Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { Pose } from '../pose.js';
import {
  type AnimationSpec,
  animationFor,
  type ClipName,
  createFlourishSchedule,
  evaluateFlourish,
  evaluateOverlay,
  FLOURISH_DURATION_S,
  type FlourishKind,
  type FlourishSchedule,
  flourishAllowed,
  OVERLAY_BONES,
  type OverlayBone,
  type OverlayKind,
  type OverlayPose,
  type PropKind,
  type PropPlacement,
  type ScheduledFlourish,
  USED_CLIPS,
  WALK_STRIDE_MODEL_UNITS,
} from './anim.js';
import type { AvatarBody } from './body.js';
import { COOLDOWN_EMISSIVE, COOLDOWN_EMISSIVE_INTENSITY } from './emote-math.js';
import { mergeAttachment } from './merge.js';
import {
  accessoryBone,
  accessoryMesh,
  applyOutfitColors,
  collectMaterials,
  disposeMaterials,
  EXTRA_NODES,
  hairStyleMesh,
  materialsFor,
  type OutfitMaterials,
  type OutfitResources,
  PART_NODES,
  propMesh,
  slotColor,
  slotForNode,
} from './outfit.js';

/**
 * The rigged character: `rogue.glb` (KayKit Adventurers, CC0) loaded once, cloned per avatar with
 * `SkeletonUtils.clone`, dressed from the `Avatar` DTO (`outfit.ts`) and driven by the pure pose
 * table in `anim.ts` through an `AnimationMixer` plus procedural bone overlays and gravity-aligned
 * hand props.
 *
 * ## Measured model facts (bind pose, model units; Node one-off against the committed GLB)
 *
 * - Height 2.187 (feet at y = 0, crown of the head mesh at 2.187); scaled uniformly so the standing
 *   character is `CHARACTER_HEIGHT` world units tall (`modelScale ≈ 0.663`, recomputed at load from
 *   the body-part geometry so a stripped GLB keeps working).
 * - Forward axis is **+Z**: the cape hangs at −Z, the head mesh's centroid and nose are at +Z, and
 *   `Interact` reaches to z +0.65. That already matches the G1b convention (local +Z = front, yaw =
 *   `facingYaw`), so `MODEL_YAW_OFFSET` is 0.
 * - Bones: `root` → `hips` (0.406) → `spine` → `chest` (0.973) → `head` (1.241); arms from
 *   `upperarm` (±0.212, 1.107) through `lowerarm`, `wrist`, `hand` to `handslot` (±0.883, 1.049);
 *   bind pose is a T-pose. GLTFLoader sanitises node names (`PropertyBinding.sanitizeNodeName`), so
 *   `handslot.l` becomes `handslotl`: look bones up with `BONE_NODES`. IK helper bones are untouched.
 * - `Sit_Chair_Idle` puts the hips at (0, 0.481, −0.397): the body sits 0.4 model units behind the
 *   root with the thighs level and the feet dangling; the clip assumes a ~0.45-unit seat. The Kenney
 *   `chairDesk` seat top is 0.467 world units high (face-area histogram of the GLB at its 0.2 scale)
 *   with its centroid 0.05 in front of the tile centre; the sofa seat is 0.446 / 0.09. Hence
 *   `SEAT_FORWARD` (root moves forward so the hips land on the seat centroid) and `SEAT_LIFT`.
 * - `Walking_A` is in place (root motion 0): each foot travels 0.40 along z per step, 0.80 per cycle
 *   (`WALK_STRIDE_MODEL_UNITS`), 1.0667 s per cycle.
 *
 * Idle variety: while the base pose is a plain `Idle` / `Sit_Chair_Idle` with no overlay, a seeded
 * schedule (`createFlourishSchedule(hash(id))`) starts a short look-around / stretch / weight shift
 * every 6–14 s as one more fading overlay layer (`advanceFlourish`); any other pose cancels it.
 *
 * This module imports `three/addons` (GLTFLoader, SkeletonUtils, BufferGeometryUtils through
 * `merge.ts`) and must not be imported by tests; the pure parts live in `anim.ts`, `outfit.ts` and
 * `math.ts`.
 */

export const CHARACTER_URL = '/models/characters/rogue.glb';
/** Standing height of a non-intern character in world units (tiles). */
export const CHARACTER_HEIGHT = 1.45;
/** Measured height of the GLB in model units; the fallback when the geometry box is degenerate. */
export const MODEL_HEIGHT = 2.187;
/** The model already faces +Z, the scene's front direction. */
export const MODEL_YAW_OFFSET = 0;
/** Seated: shift along the facing so the hips sit on the chair's seat, and lift onto its top. */
export const SEAT_FORWARD = 0.3;
export const SEAT_LIFT = 0.19;
/** Hit cylinder of the standing character (the head is 1.1 model units wide → 0.36 world). */
export const HIT_RADIUS = 0.36;
export const CROSSFADE_S = 0.2;
export const OVERLAY_FADE_S = 0.25;
/** Top of the skull above the `head` bone in model units (measured, see `outfit.ts`). */
export const HEAD_TOP_ABOVE_BONE = 0.95;

/** Sanitised GLB node names of the bones the overlays and props use. */
export const BONE_NODES: Record<OverlayBone | 'handSlotL' | 'handSlotR', string> = {
  hips: 'hips',
  chest: 'chest',
  head: 'head',
  upperArmL: 'upperarml',
  lowerArmL: 'lowerarml',
  handL: 'handl',
  upperArmR: 'upperarmr',
  lowerArmR: 'lowerarmr',
  handR: 'handr',
  handSlotL: 'handslotl',
  handSlotR: 'handslotr',
};

export interface CharacterAsset {
  /** The prepared source scene (extras removed, materials dropped). Never rendered; clone it. */
  scene: Group;
  clips: Map<ClipName, AnimationClip>;
  modelHeight: number;
  /** Uniform scale that makes the model `CHARACTER_HEIGHT` tall. */
  modelScale: number;
}

// ---- loader ---------------------------------------------------------------------------------------

let pending: Promise<CharacterAsset | null> | null = null;
let loaded: CharacterAsset | null = null;

/** Load and prepare the character once; resolves null after one `console.warn` on failure. */
export function loadCharacter(): Promise<CharacterAsset | null> {
  if (!pending) {
    pending = new Promise<CharacterAsset | null>((resolve) => {
      new GLTFLoader().load(
        CHARACTER_URL,
        (gltf) => {
          try {
            loaded = prepare(gltf.scene, gltf.animations);
            resolve(loaded);
          } catch (err) {
            console.warn(`[three] character ${CHARACTER_URL} could not be prepared`, err);
            resolve(null);
          }
        },
        undefined,
        (err) => {
          console.warn(`[three] character ${CHARACTER_URL} failed to load`, err);
          resolve(null);
        },
      );
    });
  }
  return pending;
}

/** Forget the cached character (tests, or when the renderer is switched off for good). */
export function clearCharacterCache(): void {
  if (loaded) {
    loaded.scene.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
  }
  loaded = null;
  pending = null;
}

function prepare(scene: Group, animations: AnimationClip[]): CharacterAsset {
  for (const name of EXTRA_NODES) scene.getObjectByName(name)?.removeFromParent();
  // The gradient atlas and its material are never used: free them now, clones get flat materials.
  const seen = new Set<Material>();
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const mats: Material | Material[] = o.material;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      if (seen.has(m)) continue;
      seen.add(m);
      const map: unknown = (m as { map?: Texture | null }).map;
      if (map && typeof map === 'object' && 'dispose' in map) (map as Texture).dispose();
      m.dispose();
    }
  });
  const box = new Box3();
  for (const name of PART_NODES) {
    const mesh = scene.getObjectByName(name);
    if (!(mesh instanceof SkinnedMesh)) continue;
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
  }
  const size = box.isEmpty() ? new Vector3() : box.getSize(new Vector3());
  const modelHeight = size.y > 0.1 && Number.isFinite(size.y) ? size.y : MODEL_HEIGHT;
  const clips = new Map<ClipName, AnimationClip>();
  for (const name of USED_CLIPS) {
    const clip = animations.find((a) => a.name === name);
    if (clip) clips.set(name, clip);
    else console.warn(`[three] character clip ${name} is missing`);
  }
  if (!clips.has('Idle')) throw new Error('rogue.glb has no Idle clip');
  return { scene, clips, modelHeight, modelScale: CHARACTER_HEIGHT / modelHeight };
}

// ---- rig ------------------------------------------------------------------------------------------

interface OverlayLayer {
  kind: OverlayKind;
  weight: number;
}

/** An idle flourish in flight: its own clock plus the usual fade weight. */
interface FlourishLayer {
  kind: FlourishKind;
  t: number;
  weight: number;
}

interface PropNode {
  group: Group;
  slot: Object3D;
  materials: Set<Material>;
}

/** Appearance fields that force a rebuild of the hair / accessory meshes. */
function appearanceKey(avatar: Avatar, isIntern: boolean): string {
  return [
    avatar.hairStyle,
    avatar.hair,
    avatar.accessory,
    avatar.shirt,
    avatar.pants,
    isIntern ? 'i' : 'a',
  ].join('|');
}

/** Orientation of `object` relative to `root` (the character frame), from the local quaternions. */
function relativeQuaternion(object: Object3D, root: Object3D, out: Quaternion): Quaternion {
  out.copy(object.quaternion);
  let n = object.parent;
  while (n && n !== root) {
    out.premultiply(n.quaternion);
    n = n.parent;
  }
  return out;
}

const _qp = new Quaternion();
const _qd = new Quaternion();
const _qt = new Quaternion();
const _euler = new Euler();

export class CharacterRig implements AvatarBody {
  readonly object = new Group();
  readonly hitRadius = HIT_RADIUS;
  readonly hitHeight = CHARACTER_HEIGHT;
  readonly seatForward = SEAT_FORWARD;
  readonly seatLift = SEAT_LIFT;

  private readonly model: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<ClipName, AnimationAction>();
  private current: AnimationAction | null = null;
  private currentClip: ClipName | null = null;
  private readonly bones: Partial<Record<OverlayBone | 'handSlotL' | 'handSlotR', Object3D>> = {};
  private readonly saved = new Map<Object3D, Quaternion>();
  private readonly outfit: OutfitMaterials;
  private readonly fadeMaterials = new Set<Material>();
  private hair: Group | null = null;
  private accessory: Group | null = null;
  private readonly props = new Map<PropKind, PropNode>();
  private overlay: OverlayLayer | null = null;
  private previous: OverlayLayer | null = null;
  private flourish: FlourishLayer | null = null;
  private readonly schedule: FlourishSchedule;
  private nextFlourish: ScheduledFlourish;
  private flourishWasAllowed = false;
  private spec: AnimationSpec;
  private pose: Pose = 'idle';
  private seated = false;
  private scale = 1;
  private avatarKey = '';
  private avatar: Avatar;
  private intern: boolean;
  private clock: number;
  private opacity = 1;
  private tinted = false;
  private disposed = false;

  constructor(
    private readonly asset: CharacterAsset,
    private readonly res: OutfitResources,
    init: { avatar: Avatar; isIntern: boolean; phase: number; seed?: number },
  ) {
    this.object.name = 'character';
    this.object.scale.setScalar(asset.modelScale);
    this.object.rotation.y = MODEL_YAW_OFFSET;
    this.model = cloneSkeleton(asset.scene);
    this.object.add(this.model);
    this.avatar = init.avatar;
    this.intern = init.isIntern;
    this.clock = init.phase * 10;
    this.schedule = createFlourishSchedule(init.seed ?? 0);
    this.nextFlourish = this.schedule.next(this.clock);

    this.outfit = materialsFor(init.avatar, init.isIntern);
    for (const m of [this.outfit.skin, this.outfit.shirt, this.outfit.pants])
      this.fadeMaterials.add(m);
    for (const name of PART_NODES) {
      const mesh = this.model.getObjectByName(name);
      if (!(mesh instanceof SkinnedMesh)) continue;
      const slot = slotForNode(name);
      if (slot) mesh.material = this.outfit[slot];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Animated poses (sitting, cheering) leave the bind-pose bounds; the room is always on screen.
      mesh.frustumCulled = false;
    }
    for (const key of Object.keys(BONE_NODES) as (keyof typeof BONE_NODES)[]) {
      const bone = this.model.getObjectByName(BONE_NODES[key]);
      if (bone) this.bones[key] = bone;
    }
    this.mixer = new AnimationMixer(this.model);
    this.spec = animationFor('idle', this.context());
    this.play(this.spec, init.phase);
    this.rebuildAttachments();
  }

  // ---- AvatarBody ---------------------------------------------------------------------------------

  setAppearance(avatar: Avatar, isIntern: boolean): void {
    this.avatar = avatar;
    this.intern = isIntern;
    applyOutfitColors(this.outfit, avatar, isIntern);
    const key = appearanceKey(avatar, isIntern);
    if (key !== this.avatarKey) this.rebuildAttachments();
  }

  setPose(pose: Pose): void {
    if (pose === this.pose) return;
    this.pose = pose;
    this.refresh();
  }

  setSeated(seated: boolean): void {
    if (seated === this.seated) return;
    this.seated = seated;
    this.refresh();
  }

  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.refresh();
  }

  setOpacity(opacity: number): void {
    const o = Math.min(1, Math.max(0, opacity));
    if (o === this.opacity) return;
    this.opacity = o;
    for (const m of this.fadeMaterials) applyOpacity(m, o);
  }

  setTint(on: boolean): void {
    if (on === this.tinted) return;
    this.tinted = on;
    for (const m of [this.outfit.skin, this.outfit.shirt, this.outfit.pants]) applyTint(m, on);
    if (this.hair) for (const m of collectMaterials(this.hair)) applyTint(m, on);
  }

  /** The head bone's world position plus the skull height (scaled); the model top if no bone. */
  headTop(out: Vector3): Vector3 {
    const head = this.bones.head;
    if (head) {
      head.getWorldPosition(out);
      out.y += HEAD_TOP_ABOVE_BONE * this.asset.modelScale * this.scale;
      return out;
    }
    return this.object.localToWorld(out.set(0, this.asset.modelHeight, 0));
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.clock += dt;
    for (const [bone, q] of this.saved) bone.quaternion.copy(q);
    this.mixer.update(dt);
    this.advanceOverlayWeights(dt);
    this.advanceFlourish(dt);
    this.applyOverlays();
  }

  dispose(): void {
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    for (const m of [this.outfit.skin, this.outfit.shirt, this.outfit.pants]) m.dispose();
    if (this.hair) disposeMaterials(this.hair);
    if (this.accessory) disposeMaterials(this.accessory);
    for (const p of this.props.values()) disposeMaterials(p.group);
    this.props.clear();
    this.object.removeFromParent();
  }

  // ---- clips --------------------------------------------------------------------------------------

  private context(): { seated: boolean; moving: boolean; strideTilesPerCycle: number } {
    return {
      seated: this.seated,
      moving: false,
      strideTilesPerCycle: WALK_STRIDE_MODEL_UNITS * this.asset.modelScale * this.scale,
    };
  }

  private refresh(): void {
    const spec = animationFor(this.pose, this.context());
    this.spec = spec;
    this.play(spec);
    this.setOverlay(spec.overlay);
    for (const [kind, node] of this.props) node.group.visible = kind === spec.prop;
    if (spec.prop) this.prop(spec.prop).group.visible = true;
  }

  private play(spec: AnimationSpec, phase = 0): void {
    const clip = this.asset.clips.get(spec.clip) ?? this.asset.clips.get('Idle');
    if (!clip) return;
    let next = this.actions.get(spec.clip);
    if (!next) {
      next = this.mixer.clipAction(clip);
      this.actions.set(spec.clip, next);
    }
    const once = spec.loop === 'once-hold';
    next.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Number.POSITIVE_INFINITY);
    next.clampWhenFinished = once;
    next.setEffectiveTimeScale(spec.timeScale);
    if (this.currentClip === spec.clip && this.current) return;
    next.reset();
    next.setEffectiveWeight(1);
    next.play();
    if (phase > 0) next.time = (phase % 1) * clip.duration;
    if (this.current) this.current.crossFadeTo(next, CROSSFADE_S, false);
    this.current = next;
    this.currentClip = spec.clip;
  }

  // ---- overlays -----------------------------------------------------------------------------------

  private setOverlay(kind: OverlayKind | null): void {
    if ((this.overlay?.kind ?? null) === kind) return;
    if (this.overlay) this.previous = this.overlay;
    this.overlay = kind ? { kind, weight: 0 } : null;
  }

  private advanceOverlayWeights(dt: number): void {
    const step = dt / OVERLAY_FADE_S;
    if (this.overlay) this.overlay.weight = Math.min(1, this.overlay.weight + step);
    if (this.previous) {
      this.previous.weight -= step;
      if (this.previous.weight <= 0) this.previous = null;
    }
  }

  /**
   * Idle flourishes (`anim.ts`): start the scheduled one when the base pose allows it, fade it out
   * early if the pose changes, and schedule the next from the seeded stream once it is gone. A
   * flourish that fell due while the character was busy is re-rolled when it goes idle again, so
   * sitting down never triggers one on the spot.
   */
  private advanceFlourish(dt: number): void {
    const allowed = flourishAllowed(this.spec);
    if (allowed && !this.flourishWasAllowed && this.nextFlourish.at <= this.clock)
      this.nextFlourish = this.schedule.next(this.clock);
    this.flourishWasAllowed = allowed;
    const f = this.flourish;
    const step = dt / OVERLAY_FADE_S;
    if (f) {
      f.t += dt;
      const playing = allowed && f.t < FLOURISH_DURATION_S[f.kind];
      f.weight = playing ? Math.min(1, f.weight + step) : f.weight - step;
      if (!playing && f.weight <= 0) {
        this.flourish = null;
        this.nextFlourish = this.schedule.next(this.clock);
      }
      return;
    }
    if (allowed && this.clock >= this.nextFlourish.at)
      this.flourish = { kind: this.nextFlourish.kind, t: 0, weight: 0 };
  }

  /**
   * Multiply the overlay bones' orientations (as written by the mixer this frame) with the
   * weighted deltas, parent-first so a child's delta composes on top of its parent's. The
   * pre-overlay quaternions are saved (one persistent slot per bone) and restored before the next
   * `mixer.update`, so bones a clip does not animate never accumulate rotation; restoring a bone
   * that was not touched this frame is a no-op since its value never changed.
   */
  private applyOverlays(): void {
    const layers: { pose: OverlayPose; w: number }[] = [];
    if (this.previous && this.previous.weight > 0)
      layers.push({
        pose: evaluateOverlay(this.previous.kind, this.clock),
        w: this.previous.weight,
      });
    if (this.overlay && this.overlay.weight > 0)
      layers.push({ pose: evaluateOverlay(this.overlay.kind, this.clock), w: this.overlay.weight });
    const f = this.flourish;
    if (f && f.weight > 0) layers.push({ pose: evaluateFlourish(f.kind, f.t), w: f.weight });
    if (layers.length === 0) {
      this.placeProps(null);
      return;
    }
    for (const key of OVERLAY_BONES) {
      const bone = this.bones[key];
      if (!bone) continue;
      let touched = false;
      for (const { pose, w } of layers) {
        const d = pose.bones[key];
        if (!d) continue;
        if (!touched) {
          let q = this.saved.get(bone);
          if (!q) {
            q = new Quaternion();
            this.saved.set(bone, q);
          }
          q.copy(bone.quaternion);
          touched = true;
        }
        this.rotateInCharacterFrame(bone, d.x * w, d.y * w, d.z * w);
      }
    }
    const active = this.overlay ?? this.previous;
    const placement = active ? evaluateOverlay(active.kind, this.clock).prop : null;
    this.placeProps(placement);
  }

  /** Rotate `bone` by an XYZ Euler delta expressed in the character frame, about its own pivot. */
  private rotateInCharacterFrame(bone: Object3D, x: number, y: number, z: number): void {
    const parent = bone.parent;
    if (!parent) return;
    relativeQuaternion(parent, this.model, _qp);
    _qd.setFromEuler(_euler.set(x, y, z, 'XYZ'));
    // local' = parentᵀ · D · parent · local
    _qt.copy(_qp).invert().multiply(_qd).multiply(_qp);
    bone.quaternion.premultiply(_qt);
  }

  // ---- props --------------------------------------------------------------------------------------

  private prop(kind: PropKind): PropNode {
    let node = this.props.get(kind);
    if (node) return node;
    const group = mergeAttachment(propMesh(kind, this.res), this.res, `prop:${kind}`);
    const slot = this.bones[kind === 'book' ? 'handSlotL' : 'handSlotR'] ?? this.model;
    slot.add(group);
    const materials = collectMaterials(group);
    for (const m of materials) {
      this.fadeMaterials.add(m);
      applyOpacity(m, this.opacity);
    }
    node = { group, slot, materials };
    this.props.set(kind, node);
    return node;
  }

  /**
   * Props follow their hand slot for position but are re-oriented to the character frame every
   * frame (gravity-aligned), then tilted as the overlay says: a mug stays upright while the arm
   * swings and tips towards the mouth only when the sip says so.
   */
  private placeProps(placement: PropPlacement | null): void {
    for (const [kind, node] of this.props) {
      const show = placement?.prop === kind && this.spec.prop === kind;
      node.group.visible = show;
      if (!show || !placement) continue;
      relativeQuaternion(node.slot, this.model, _qp);
      _qt.copy(_qp).invert();
      _qd.setFromEuler(_euler.set(placement.tilt.x, placement.tilt.y, placement.tilt.z, 'XYZ'));
      node.group.quaternion.copy(_qt).multiply(_qd);
      node.group.position
        .set(placement.offset.x, placement.offset.y, placement.offset.z)
        .applyQuaternion(_qt);
    }
  }

  // ---- hair and accessories -----------------------------------------------------------------------

  private rebuildAttachments(): void {
    this.avatarKey = appearanceKey(this.avatar, this.intern);
    if (this.hair) {
      this.detach(this.hair);
      this.hair = null;
    }
    if (this.accessory) {
      this.detach(this.accessory);
      this.accessory = null;
    }
    const head = this.bones.head;
    if (head) {
      // One mesh per hair style / accessory (`merge.ts`): a character stays at ≤ 8 draw calls.
      this.hair = mergeAttachment(
        hairStyleMesh(this.avatar.hairStyle, slotColor(this.avatar, 'hair', this.intern), this.res),
        this.res,
        `hair:${this.avatar.hairStyle}`,
      );
      head.add(this.hair);
      this.track(this.hair);
      if (this.tinted) for (const m of collectMaterials(this.hair)) applyTint(m, true);
    }
    const boneKey = accessoryBone(this.avatar.accessory);
    const bone = boneKey ? this.bones[boneKey] : undefined;
    if (bone) {
      this.accessory = mergeAttachment(
        accessoryMesh(this.avatar.accessory, this.avatar, this.intern, this.res),
        this.res,
        `accessory:${this.avatar.accessory}`,
      );
      bone.add(this.accessory);
      this.track(this.accessory);
    }
  }

  private track(group: Group): void {
    for (const m of collectMaterials(group)) {
      this.fadeMaterials.add(m);
      applyOpacity(m, this.opacity);
    }
  }

  private detach(group: Group): void {
    for (const m of collectMaterials(group)) this.fadeMaterials.delete(m);
    disposeMaterials(group);
    group.removeFromParent();
  }
}

/** The cooldown cast: a weak blue emissive on a standard material (no-op for other materials). */
export function applyTint(m: Material, on: boolean): void {
  if (!('emissive' in m) || !('emissiveIntensity' in m)) return;
  const std = m as Material & {
    emissive: { setHex(hex: number): unknown };
    emissiveIntensity: number;
  };
  std.emissive.setHex(on ? COOLDOWN_EMISSIVE : 0x000000);
  std.emissiveIntensity = on ? COOLDOWN_EMISSIVE_INTENSITY : 0;
}

function applyOpacity(m: Material, opacity: number): void {
  const transparent = opacity < 1;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.needsUpdate = true;
  }
  m.opacity = opacity;
}
