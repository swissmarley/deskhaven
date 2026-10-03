import type { Avatar, Facing } from '@agenthotel/shared';
import {
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Raycaster,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { hslToRgb, parseHex, rgbToHsl } from '../color.js';
import type { Pose } from '../pose.js';
import type { SceneAvatarInit } from '../scene.js';
import { facingYaw } from './math.js';

/**
 * Capsule avatars for the Three renderer (G1b stand-in until the rigged characters of G2): a
 * shirt-coloured capsule body with a pants band, a skin-coloured head and a small nose cone on the
 * front so the facing is visible in screenshots. The avatar's local +Z is its front; the root's
 * yaw comes from `facingYaw`. Interns are scaled 0.8 and their colours washed out.
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

const FALLBACK = { skin: 0xf1c27d, shirt: 0x3a86ff, pants: 0x3d405b } as const;

interface AvatarNode {
  root: Group;
  body: Group;
  meshes: Mesh[];
  shirt: MeshStandardMaterial;
  pants: MeshStandardMaterial;
  skin: MeshStandardMaterial;
  ring: Mesh;
  ringMaterial: MeshStandardMaterial;
  intern: boolean;
  pose: Pose;
  seated: boolean;
  /** Remaining fade time while leaving, or null. */
  fade: number | null;
  poof: number;
  clock: number;
}

/** Wash a colour out for interns: half the saturation, lighter. */
export function internTint(color: number): number {
  const [h, s, l] = rgbToHsl(color);
  return hslToRgb(h, s * 0.5, Math.min(0.9, l + 0.18));
}

export class AvatarMeshes {
  readonly group = new Group();
  private readonly nodes = new Map<string, AvatarNode>();
  private readonly bodyGeometry = new CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 4, 12);
  private readonly pantsGeometry = new CylinderGeometry(
    BODY_RADIUS + 0.012,
    BODY_RADIUS + 0.012,
    0.3,
    16,
  );
  private readonly headGeometry = new SphereGeometry(HEAD_RADIUS, 16, 12);
  private readonly noseGeometry = new ConeGeometry(0.045, 0.1, 8).rotateX(Math.PI / 2);
  private readonly ringGeometry = new TorusGeometry(0.34, 0.03, 8, 32).rotateX(-Math.PI / 2);

  constructor(private readonly parent: Object3D) {
    this.group.name = 'avatars';
    parent.add(this.group);
  }

  add(init: SceneAvatarInit): void {
    this.remove(init.id);
    const root = new Group();
    root.name = `avatar:${init.id}`;
    root.userData = { avatarId: init.id };
    const body = new Group();
    const shirt = new MeshStandardMaterial({ roughness: 0.75 });
    const pants = new MeshStandardMaterial({ roughness: 0.85 });
    const skin = new MeshStandardMaterial({ roughness: 0.6 });
    const capsule = new Mesh(this.bodyGeometry, shirt);
    capsule.position.y = BODY_RADIUS + BODY_LENGTH / 2;
    const band = new Mesh(this.pantsGeometry, pants);
    band.position.y = 0.26;
    const head = new Mesh(this.headGeometry, skin);
    head.position.y = BODY_LENGTH + BODY_RADIUS * 2 + HEAD_RADIUS - 0.03;
    const nose = new Mesh(this.noseGeometry, skin);
    nose.position.set(0, head.position.y - 0.02, HEAD_RADIUS + 0.03);
    const meshes = [capsule, band, head, nose];
    for (const m of meshes) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    body.add(...meshes);
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
    root.add(body, ring);
    const node: AvatarNode = {
      root,
      body,
      meshes,
      shirt,
      pants,
      skin,
      ring,
      ringMaterial,
      intern: init.isIntern,
      pose: 'idle',
      seated: false,
      fade: null,
      poof: 0,
      clock: 0,
    };
    this.nodes.set(init.id, node);
    this.applyAppearance(node, init.avatar, init.isIntern);
    this.setFacing(init.id, 2);
    this.group.add(root);
  }

  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    this.group.remove(node.root);
    node.shirt.dispose();
    node.pants.dispose();
    node.skin.dispose();
    node.ringMaterial.dispose();
  }

  setAppearance(id: string, avatar: Avatar, isIntern: boolean): void {
    const node = this.nodes.get(id);
    if (node) this.applyAppearance(node, avatar, isIntern);
  }

  setPose(id: string, pose: Pose): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.pose = pose;
    if (pose === 'leave' && node.fade === null) {
      node.fade = LEAVE_FADE_S;
      for (const m of [node.shirt, node.pants, node.skin]) {
        m.transparent = true;
        m.needsUpdate = true;
      }
    }
    if (pose !== 'walk') this.applyBodyOffset(node, 0);
  }

  setFacing(id: string, facing: Facing): void {
    const node = this.nodes.get(id);
    if (node) node.root.rotation.y = facingYaw(facing);
  }

  setSeated(id: string, seated: boolean): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.seated = seated;
    this.applyBodyOffset(node, 0);
  }

  setPosition(id: string, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (node) node.root.position.set(x, 0, y);
  }

  setHighlighted(id: string, on: boolean): void {
    const node = this.nodes.get(id);
    if (node) node.ring.visible = on;
  }

  poof(id: string): void {
    const node = this.nodes.get(id);
    if (node) node.poof = POOF_S;
  }

  isFinished(id: string): boolean {
    const node = this.nodes.get(id);
    return node !== undefined && node.fade !== null && node.fade <= 0;
  }

  /** The avatar id under a ray, or null. */
  pick(raycaster: Raycaster): string | null {
    const hits = raycaster.intersectObjects(this.group.children, true);
    for (const hit of hits) {
      if (hit.object.userData.pickable === false) continue;
      const id = avatarIdOf(hit.object);
      if (id) return id;
    }
    return null;
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const node of this.nodes.values()) {
      node.clock += dt;
      if (node.fade !== null && node.fade > 0) {
        node.fade = Math.max(0, node.fade - dt);
        const opacity = node.fade / LEAVE_FADE_S;
        node.shirt.opacity = opacity;
        node.pants.opacity = opacity;
        node.skin.opacity = opacity;
      }
      const bob =
        node.pose === 'walk' ? Math.abs(Math.sin(node.clock * WALK_HZ * Math.PI)) * WALK_BOB : 0;
      this.applyBodyOffset(node, bob);
      let scale = node.intern ? INTERN_SCALE : 1;
      if (node.poof > 0) {
        node.poof = Math.max(0, node.poof - dt);
        scale *= 1 + 0.25 * Math.sin((Math.PI * (POOF_S - node.poof)) / POOF_S);
      }
      node.body.scale.setScalar(scale);
      if (node.ring.visible)
        node.ringMaterial.emissiveIntensity = 0.45 + 0.35 * (Math.sin(node.clock * 5) + 1) * 0.5;
    }
  }

  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.remove(id);
    this.bodyGeometry.dispose();
    this.pantsGeometry.dispose();
    this.headGeometry.dispose();
    this.noseGeometry.dispose();
    this.ringGeometry.dispose();
    this.parent.remove(this.group);
  }

  private applyAppearance(node: AvatarNode, avatar: Avatar, isIntern: boolean): void {
    node.intern = isIntern;
    const tint = (c: number): number => (isIntern ? internTint(c) : c);
    node.shirt.color.setHex(tint(parseHex(avatar.shirt, FALLBACK.shirt)));
    node.pants.color.setHex(tint(parseHex(avatar.pants, FALLBACK.pants)));
    node.skin.color.setHex(tint(parseHex(avatar.skin, FALLBACK.skin)));
    node.body.scale.setScalar(isIntern ? INTERN_SCALE : 1);
  }

  /** Seated avatars sink a little and lean towards their desk (local +Z is the facing direction). */
  private applyBodyOffset(node: AvatarNode, bob: number): void {
    node.body.position.set(0, (node.seated ? -SEAT_DROP : 0) + bob, node.seated ? SEAT_FORWARD : 0);
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
