import type { Avatar, Facing } from '@agenthotel/shared';
import {
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  type Quaternion,
  type Raycaster,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { internTint, parseHex } from '../color.js';
import { tileKey } from '../grid.js';
import { facing8FromDelta, yawFor8 } from '../iso.js';
import type { Pose } from '../pose.js';
import { hashString } from '../rng.js';
import type { SceneAvatarInit } from '../scene.js';
import type { AvatarBody } from './body.js';
import { applyTint, type CharacterAsset, CharacterRig, loadCharacter } from './character.js';
import { screenSide } from './emote-math.js';
import { AvatarEmotes, EmoteResources } from './emotes.js';
import { approachYaw, facingYaw } from './math.js';
import { OutfitResources } from './outfit.js';

export { internTint } from '../color.js';

/**
 * Avatars for the Three renderer. Each avatar is a root group (tile position, yaw) holding a body
 * group (intern / poof scale, seat offset) that contains an `AvatarBody`: the G1b capsule until
 * `loadCharacter()` resolves, then a `CharacterRig` swapped in place (the capsule stays, with one
 * warning from the loader, when the GLB fails). The owner also keeps an invisible hit cylinder per
 * avatar for picking, the highlight ring, the leave fade, the 8-way yaw smoothing and the emotes
 * (`emotes.ts`, a sibling group that follows the root without rotating), and reports the head top
 * (`headAnchors`) for the DOM labels and the typing tiles for the monitor glow.
 *
 * Facing: the core sends 4-way `Facing`s (stations, arrival) and per-frame fractional positions.
 * While the pose is `walk` the yaw target comes from the position delta (8 directions, steps under
 * 1e-3 ignored); any other pose uses the core's facing. The yaw eases towards its target along the
 * shortest arc (`approachYaw`, ~12/s).
 *
 * Picking: the Raycaster in three 0.186 does not skip invisible objects (checked in
 * `Raycaster.intersect`), so each avatar has a `visible = false` cylinder under its body group and
 * `pick` intersects only that list — the skinned meshes are never raycast (per-vertex skinning for
 * 4.3k triangles × 8 avatars on every pointer move would be too slow).
 */

export const BODY_RADIUS = 0.22;
export const BODY_LENGTH = 0.6;
export const HEAD_RADIUS = 0.16;
export const INTERN_SCALE = 0.8;
export const SEAT_DROP = 0.25;
export const SEAT_FORWARD = 0.05;
export const LEAVE_FADE_S = 0.7;
export const POOF_S = 0.4;
export const WALK_BOB = 0.035;
export const WALK_HZ = 2.2;
export const AVATAR_HIGHLIGHT = 0xffd166;
/** Position steps shorter than this are jitter and do not turn the avatar. */
export const MIN_TURN_STEP = 1e-3;

const FALLBACK = { skin: 0xf1c27d, shirt: 0x3a86ff, pants: 0x3d405b } as const;

interface AvatarNode {
  id: string;
  root: Group;
  bodyGroup: Group;
  body: AvatarBody;
  hit: Mesh;
  ring: Mesh;
  ringMaterial: MeshStandardMaterial;
  emotes: AvatarEmotes;
  avatar: Avatar;
  intern: boolean;
  pose: Pose;
  seated: boolean;
  /** Remaining fade time while leaving, or null. */
  fade: number | null;
  poof: number;
  clock: number;
  yaw: number;
  targetYaw: number;
  /** The last 4-way facing the core sent, as a yaw. */
  coreYaw: number;
  x: number;
  y: number;
  placed: boolean;
}

/** Geometries shared by the capsule bodies of one scene. */
class CapsuleGeometries {
  readonly body = new CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 4, 12);
  readonly band = new CylinderGeometry(BODY_RADIUS + 0.012, BODY_RADIUS + 0.012, 0.3, 16);
  readonly head = new SphereGeometry(HEAD_RADIUS, 16, 12);
  readonly nose = new ConeGeometry(0.045, 0.1, 8).rotateX(Math.PI / 2);

  dispose(): void {
    this.body.dispose();
    this.band.dispose();
    this.head.dispose();
    this.nose.dispose();
  }
}

/**
 * The G1b capsule: shirt-coloured capsule with a pants band, skin head and a nose cone marking the
 * front. Placeholder while the character loads and the fallback when it cannot.
 */
export class CapsuleBody implements AvatarBody {
  readonly object = new Group();
  readonly hitRadius = BODY_RADIUS + 0.03;
  readonly hitHeight = BODY_LENGTH + BODY_RADIUS * 2 + HEAD_RADIUS * 2 - 0.03;
  readonly seatForward = SEAT_FORWARD;
  readonly seatLift = -SEAT_DROP;
  private readonly shirt = new MeshStandardMaterial({ roughness: 0.75 });
  private readonly pants = new MeshStandardMaterial({ roughness: 0.85 });
  private readonly skin = new MeshStandardMaterial({ roughness: 0.6 });
  private readonly inner = new Group();
  private pose: Pose = 'idle';
  private clock = 0;
  private tinted = false;

  constructor(geo: CapsuleGeometries, avatar: Avatar, isIntern: boolean) {
    const capsule = new Mesh(geo.body, this.shirt);
    capsule.position.y = BODY_RADIUS + BODY_LENGTH / 2;
    const band = new Mesh(geo.band, this.pants);
    band.position.y = 0.26;
    const head = new Mesh(geo.head, this.skin);
    head.position.y = BODY_LENGTH + BODY_RADIUS * 2 + HEAD_RADIUS - 0.03;
    const nose = new Mesh(geo.nose, this.skin);
    nose.position.set(0, head.position.y - 0.02, HEAD_RADIUS + 0.03);
    for (const m of [capsule, band, head, nose]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.inner.add(capsule, band, head, nose);
    this.object.add(this.inner);
    this.setAppearance(avatar, isIntern);
  }

  setAppearance(avatar: Avatar, isIntern: boolean): void {
    const tint = (c: number): number => (isIntern ? internTint(c) : c);
    this.shirt.color.setHex(tint(parseHex(avatar.shirt, FALLBACK.shirt)));
    this.pants.color.setHex(tint(parseHex(avatar.pants, FALLBACK.pants)));
    this.skin.color.setHex(tint(parseHex(avatar.skin, FALLBACK.skin)));
  }

  setPose(pose: Pose): void {
    this.pose = pose;
    if (pose !== 'walk') this.inner.position.y = 0;
  }

  setSeated(_seated: boolean): void {}

  setScale(_scale: number): void {}

  setOpacity(opacity: number): void {
    for (const m of [this.shirt, this.pants, this.skin]) {
      const transparent = opacity < 1;
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
      m.opacity = opacity;
    }
  }

  setTint(on: boolean): void {
    if (on === this.tinted) return;
    this.tinted = on;
    for (const m of [this.shirt, this.pants, this.skin]) applyTint(m, on);
  }

  headTop(out: Vector3): Vector3 {
    this.object.updateWorldMatrix(true, false);
    return this.object.localToWorld(out.set(0, this.hitHeight, 0));
  }

  update(dt: number): void {
    this.clock += dt;
    this.inner.position.y =
      this.pose === 'walk' ? Math.abs(Math.sin(this.clock * WALK_HZ * Math.PI)) * WALK_BOB : 0;
  }

  dispose(): void {
    this.shirt.dispose();
    this.pants.dispose();
    this.skin.dispose();
    this.object.removeFromParent();
  }
}

export interface AvatarMeshesOptions {
  /** Injected in tests; defaults to the GLTF `loadCharacter`. */
  loadCharacter?: () => Promise<CharacterAsset | null>;
}

export class AvatarMeshes {
  readonly group = new Group();
  private readonly nodes = new Map<string, AvatarNode>();
  private readonly capsules = new CapsuleGeometries();
  private readonly outfitResources = new OutfitResources();
  private readonly ringGeometry = new TorusGeometry(0.34, 0.03, 8, 32).rotateX(-Math.PI / 2);
  /** Unit cylinder (radius 1, height 1, centred): scaled per avatar into the hit volume. */
  private readonly hitGeometry = new CylinderGeometry(1, 1, 1, 10, 1);
  private readonly hitMaterial = new MeshBasicMaterial({ visible: false });
  private readonly hitVolumes: Mesh[] = [];
  private readonly emoteResources = new EmoteResources();
  private readonly tmp = new Vector3();
  private asset: CharacterAsset | null = null;
  private alive = true;

  constructor(
    private readonly parent: Object3D,
    options: AvatarMeshesOptions = {},
  ) {
    this.group.name = 'avatars';
    parent.add(this.group);
    void (options.loadCharacter ?? loadCharacter)().then((asset) => {
      if (!this.alive || !asset) return;
      this.asset = asset;
      for (const node of this.nodes.values()) this.swapBody(node, this.createRig(node));
    });
  }

  add(init: SceneAvatarInit): void {
    this.remove(init.id);
    const root = new Group();
    root.name = `avatar:${init.id}`;
    root.userData = { avatarId: init.id };
    const bodyGroup = new Group();
    bodyGroup.name = 'body';
    const hit = new Mesh(this.hitGeometry, this.hitMaterial);
    hit.name = 'hit';
    hit.visible = false;
    hit.userData = { pickable: true };
    bodyGroup.add(hit);
    const ringMaterial = new MeshStandardMaterial({
      color: AVATAR_HIGHLIGHT,
      emissive: AVATAR_HIGHLIGHT,
      emissiveIntensity: 0.6,
      roughness: 0.5,
    });
    const ring = new Mesh(this.ringGeometry, ringMaterial);
    ring.position.y = 0.02;
    ring.visible = false;
    ring.userData = { pickable: false };
    root.add(bodyGroup, ring);
    const emotes = new AvatarEmotes(this.emoteResources);
    const yaw = facingYaw(2);
    const node: AvatarNode = {
      id: init.id,
      root,
      bodyGroup,
      body: this.asset
        ? this.createRigFor(init.id, init.avatar, init.isIntern)
        : new CapsuleBody(this.capsules, init.avatar, init.isIntern),
      hit,
      ring,
      ringMaterial,
      emotes,
      avatar: init.avatar,
      intern: init.isIntern,
      pose: 'idle',
      seated: false,
      fade: null,
      poof: 0,
      clock: 0,
      yaw,
      targetYaw: yaw,
      coreYaw: yaw,
      x: 0,
      y: 0,
      placed: false,
    };
    this.nodes.set(init.id, node);
    this.hitVolumes.push(hit);
    root.rotation.y = yaw;
    this.group.add(root, emotes.group);
    this.attachBody(node, node.body);
  }

  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    const i = this.hitVolumes.indexOf(node.hit);
    if (i >= 0) this.hitVolumes.splice(i, 1);
    this.group.remove(node.root);
    node.body.dispose();
    node.emotes.dispose();
    node.ringMaterial.dispose();
  }

  setAppearance(id: string, avatar: Avatar, isIntern: boolean): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.avatar = avatar;
    node.intern = isIntern;
    node.body.setAppearance(avatar, isIntern);
    node.body.setScale(isIntern ? INTERN_SCALE : 1);
    this.applyBodyTransform(node);
  }

  setPose(id: string, pose: Pose): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.pose = pose;
    node.body.setPose(pose);
    node.body.setTint(pose === 'cooldown');
    node.emotes.setPose(pose);
    if (pose === 'leave' && node.fade === null) node.fade = LEAVE_FADE_S;
    // Standing still: the core's facing wins over the last walking direction.
    if (pose !== 'walk') node.targetYaw = node.coreYaw;
  }

  setFacing(id: string, facing: Facing): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.coreYaw = facingYaw(facing);
    if (node.pose !== 'walk') node.targetYaw = node.coreYaw;
  }

  setSeated(id: string, seated: boolean): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.seated = seated;
    node.body.setSeated(seated);
    this.applyBodyTransform(node);
  }

  setPosition(id: string, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.placed && node.pose === 'walk') {
      const dx = x - node.x;
      const dy = y - node.y;
      if (Math.hypot(dx, dy) > MIN_TURN_STEP) node.targetYaw = yawFor8(facing8FromDelta(dx, dy));
    }
    node.x = x;
    node.y = y;
    node.placed = true;
    node.root.position.set(x, 0, y);
    node.emotes.group.position.set(x, 0, y);
  }

  setHighlighted(id: string, on: boolean): void {
    const node = this.nodes.get(id);
    if (node) node.ring.visible = on;
  }

  poof(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.poof = POOF_S;
    node.emotes.poof();
  }

  /** World position of the top of each avatar's head (after this frame's animation). */
  headAnchors(fn: (id: string, point: Vector3, intern: boolean) => void): void {
    for (const node of this.nodes.values()) fn(node.id, node.body.headTop(this.tmp), node.intern);
  }

  /** Tile keys of the avatars typing at a desk right now (the monitor glow). */
  typingTiles(out: Set<string>): Set<string> {
    out.clear();
    for (const node of this.nodes.values()) {
      if (node.pose !== 'typing' && node.pose !== 'working') continue;
      out.add(tileKey(Math.round(node.x), Math.round(node.y)));
    }
    return out;
  }

  isFinished(id: string): boolean {
    const node = this.nodes.get(id);
    return node !== undefined && node.fade !== null && node.fade <= 0;
  }

  /** The avatar id under a ray, or null: only the invisible hit cylinders are tested. */
  pick(raycaster: Raycaster): string | null {
    if (this.hitVolumes.length === 0) return null;
    const hits = raycaster.intersectObjects(this.hitVolumes, false);
    for (const hit of hits) {
      const id = avatarIdOf(hit.object);
      if (id) return id;
    }
    return null;
  }

  /** Advance bodies and emotes; `cameraQuaternion` billboards the instanced particle quads. */
  update(dtMs: number, cameraQuaternion: Quaternion): void {
    const dt = dtMs / 1000;
    for (const node of this.nodes.values()) {
      node.clock += dt;
      if (node.fade !== null && node.fade > 0) {
        node.fade = Math.max(0, node.fade - dt);
        node.body.setOpacity(node.fade / LEAVE_FADE_S);
      }
      let scale = node.intern ? INTERN_SCALE : 1;
      if (node.poof > 0) {
        node.poof = Math.max(0, node.poof - dt);
        scale *= 1 + 0.25 * Math.sin((Math.PI * (POOF_S - node.poof)) / POOF_S);
      }
      node.bodyGroup.scale.setScalar(scale);
      node.yaw = approachYaw(node.yaw, node.targetYaw, dt);
      node.root.rotation.y = node.yaw;
      if (node.ring.visible)
        node.ringMaterial.emissiveIntensity = 0.45 + 0.35 * (Math.sin(node.clock * 5) + 1) * 0.5;
      node.body.update(dt);
      node.emotes.update(dt, {
        headTop: node.body.headTop(this.tmp).y,
        side: screenSide(node.yaw),
        scale,
        cameraQuaternion,
      });
    }
  }

  dispose(): void {
    this.alive = false;
    for (const id of [...this.nodes.keys()]) this.remove(id);
    this.capsules.dispose();
    this.ringGeometry.dispose();
    this.hitGeometry.dispose();
    this.hitMaterial.dispose();
    this.outfitResources.dispose();
    this.emoteResources.dispose();
    this.parent.remove(this.group);
  }

  // ---- bodies -------------------------------------------------------------------------------------

  private createRig(node: AvatarNode): CharacterRig {
    return this.createRigFor(node.id, node.avatar, node.intern);
  }

  private createRigFor(id: string, avatar: Avatar, isIntern: boolean): CharacterRig {
    if (!this.asset) throw new Error('character asset not loaded');
    return new CharacterRig(this.asset, this.outfitResources, {
      avatar,
      isIntern,
      // Desynchronise the idle loops: a stable per-avatar phase in [0, 1).
      phase: (hashString(id) >>> 0) / 0x1_0000_0000,
    });
  }

  private swapBody(node: AvatarNode, body: AvatarBody): void {
    if (node.body !== body) node.body.dispose();
    node.body = body;
    this.attachBody(node, body);
  }

  /** Put a body under the node's body group and sync it with the node's state. */
  private attachBody(node: AvatarNode, body: AvatarBody): void {
    node.bodyGroup.add(body.object);
    body.setScale(node.intern ? INTERN_SCALE : 1);
    body.setPose(node.pose);
    body.setTint(node.pose === 'cooldown');
    body.setSeated(node.seated);
    if (node.fade !== null) body.setOpacity(Math.max(0, node.fade) / LEAVE_FADE_S);
    node.hit.scale.set(body.hitRadius, body.hitHeight, body.hitRadius);
    node.hit.position.y = body.hitHeight / 2;
    this.applyBodyTransform(node);
  }

  /** Seated bodies shift along the facing (local +Z) onto the seat and up onto its top. */
  private applyBodyTransform(node: AvatarNode): void {
    const b = node.body;
    node.bodyGroup.position.set(0, node.seated ? b.seatLift : 0, node.seated ? b.seatForward : 0);
  }
}

/** Walk up from a hit mesh to the avatar root carrying the id. */
export function avatarIdOf(object: Object3D): string | null {
  let node: Object3D | null = object;
  while (node) {
    const id: unknown = node.userData.avatarId;
    if (typeof id === 'string') return id;
    node = node.parent;
  }
  return null;
}
