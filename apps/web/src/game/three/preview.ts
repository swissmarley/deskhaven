import type { Avatar } from '@deskhaven/shared';
import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  OrthographicCamera,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { INTERN_SCALE } from './avatars.js';
import { CharacterRig, loadCharacter } from './character.js';
import { HEMI_GROUND, HEMI_SKY } from './lights.js';
import { facingYaw } from './math.js';
import { OutfitResources } from './outfit.js';
import {
  frameFor,
  LruCache,
  PREVIEW_CACHE_MAX,
  PREVIEW_MARGIN,
  PREVIEW_TURN_RAD,
  type PreviewOptions,
  previewKey,
  previewOptions,
  previewViewDirection,
} from './preview-math.js';

/**
 * Offscreen 3D avatar preview for the HR desk: the same rigged, dressed character as the room,
 * rendered once per distinct `Avatar` into a PNG data URL. One shared `WebGLRenderer` on a canvas
 * that is never appended, a two-light scene without shadows, one `CharacterRig` re-dressed per
 * call (`setAppearance`), an orthographic camera framed from the posed bounds
 * (`Box3.setFromObject(…, true)` goes through the skinning, so quantised attributes and the idle
 * pose are both handled), and a 64-entry LRU of results. Calls are serialised through a promise
 * chain because the renderer, the rig and the canvas are shared. Never throws into the UI: any
 * failure (no WebGL, model missing) resolves `null` so the caller falls back to the pixel preview.
 *
 * Imports `three/addons` through `character.ts`: never import this module from tests (the pure
 * helpers are in `preview-math.ts`), and never statically from anything under `game/index.ts`
 * (`game/preview.ts` is the lazy wrapper the UI uses).
 */

/** Frame of the idle clip the preview shows (seconds into `Idle`, after the mixer settles). */
const POSE_TIME_S = 0.3;
const SUN_INTENSITY = 1.5;
const HEMI_INTENSITY = 0.9;
/** Camera distance from the framing centre; only the frustum matters for an orthographic view. */
const CAMERA_DISTANCE = 10;

interface PreviewContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: OrthographicCamera;
  stage: Group;
  rig: CharacterRig;
  res: OutfitResources;
}

let context: PreviewContext | null = null;
let pending: Promise<PreviewContext | null> | null = null;
let failed = false;
let queue: Promise<unknown> = Promise.resolve();
const cache = new LruCache<string, string>(PREVIEW_CACHE_MAX);
const tmpBox = new Box3();
const tmpVec = new Vector3();

/**
 * PNG data URL of the avatar (default 96 × 96, facing the camera with a three-quarter turn), or
 * null when 3D previews are unavailable in this browser.
 */
export async function renderAvatarPreview3d(
  avatar: Avatar,
  opts?: PreviewOptions,
): Promise<string | null> {
  const o = previewOptions(opts);
  const key = previewKey(avatar, o);
  const hit = cache.get(key);
  if (hit) return hit;
  const run = queue.then(
    () => renderOnce(avatar, o),
    () => null,
  );
  queue = run;
  const url = await run;
  if (url) cache.set(key, url);
  return url;
}

/** Tear down the shared renderer, rig and cache; the next call starts afresh. */
export function disposePreviewRenderer(): void {
  const ctx = context;
  context = null;
  pending = null;
  failed = false;
  cache.clear();
  if (!ctx) return;
  ctx.rig.dispose();
  ctx.res.dispose();
  ctx.scene.clear();
  ctx.renderer.dispose();
  ctx.renderer.forceContextLoss();
}

/** Previews currently cached (tests and the stats overlay). */
export function previewCacheSize(): number {
  return cache.size;
}

async function renderOnce(
  avatar: Avatar,
  o: ReturnType<typeof previewOptions>,
): Promise<string | null> {
  const ctx = await getContext();
  if (!ctx) return null;
  try {
    const { renderer, scene, camera, stage, rig } = ctx;
    rig.setAppearance(avatar, o.intern);
    stage.scale.setScalar(o.intern ? INTERN_SCALE : 1);
    stage.rotation.y = facingYaw(o.facing) + PREVIEW_TURN_RAD;
    // Re-evaluate the pose at the same clip time every call (dt 0 keeps the mixer where it is).
    rig.update(0);
    stage.updateMatrixWorld(true);
    // The precise box goes through the skinning, which reads bone matrices the renderer would only
    // refresh during a render: update the skeletons first.
    stage.traverse((o) => {
      if (o instanceof SkinnedMesh) o.skeleton.update();
    });
    tmpBox.setFromObject(stage, true);
    const framing = frameFor(
      tmpBox.isEmpty()
        ? null
        : {
            minX: tmpBox.min.x,
            minY: tmpBox.min.y,
            minZ: tmpBox.min.z,
            maxX: tmpBox.max.x,
            maxY: tmpBox.max.y,
            maxZ: tmpBox.max.z,
          },
      PREVIEW_MARGIN,
    );
    const dir = previewViewDirection();
    const c = framing.centre;
    camera.position.set(
      c.x + dir.x * CAMERA_DISTANCE,
      c.y + dir.y * CAMERA_DISTANCE,
      c.z + dir.z * CAMERA_DISTANCE,
    );
    camera.lookAt(tmpVec.set(c.x, c.y, c.z));
    camera.left = -framing.halfExtent;
    camera.right = framing.halfExtent;
    camera.top = framing.halfExtent;
    camera.bottom = -framing.halfExtent;
    camera.updateProjectionMatrix();
    renderer.setSize(o.size, o.size, false);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } catch (err) {
    console.warn('[three] avatar preview failed', err);
    return null;
  }
}

function getContext(): Promise<PreviewContext | null> {
  if (context) return Promise.resolve(context);
  if (failed) return Promise.resolve(null);
  pending ??= createContext();
  return pending;
}

async function createContext(): Promise<PreviewContext | null> {
  let renderer: WebGLRenderer | null = null;
  try {
    if (typeof document === 'undefined') throw new Error('no DOM');
    const canvas = document.createElement('canvas');
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const asset = await loadCharacter();
    if (!asset) throw new Error('character unavailable');
    const scene = new Scene();
    const hemi = new HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
    const sun = new DirectionalLight(0xffffff, SUN_INTENSITY);
    sun.position.set(-0.6, 1.2, 1.0);
    sun.castShadow = false;
    scene.add(hemi, sun, sun.target);
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 4);
    const res = new OutfitResources();
    const stage = new Group();
    stage.name = 'preview-stage';
    const rig = new CharacterRig(asset, res, {
      avatar: {
        skin: '#f1c27d',
        hair: '#4a2c17',
        hairStyle: 'short',
        shirt: '#3a86ff',
        pants: '#3d405b',
        accessory: 'none',
      },
      isIntern: false,
      phase: 0,
      seed: 1,
    });
    rig.setPose('idle');
    // Settle the idle clip on a mid-cycle frame once; later calls re-evaluate at dt 0.
    rig.update(POSE_TIME_S);
    stage.add(rig.object);
    scene.add(stage);
    context = { renderer, scene, camera, stage, rig, res };
    pending = null;
    return context;
  } catch (err) {
    console.warn('[three] 3D avatar previews unavailable', err);
    failed = true;
    pending = null;
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
    return null;
  }
}
