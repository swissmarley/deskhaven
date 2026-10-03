# Continue AgentHotel: graphics overhaul with 3D, high-polish characters

You are a senior full-stack and game engineer picking up **AgentHotel**, a Habbo-inspired isometric
office where every avatar is a real Claude Code agent (Claude Agent SDK). The product is complete and
verified (milestones M0–M7, see below). The next job is a **graphics overhaul: replace the placeholder
pixel look with 3D, high-polish characters and furniture**, without breaking anything that works.

## Where things are
- Repo: the repository root (git, branch `main`, one commit per milestone).
  Run with `pnpm i && pnpm dev` → server `127.0.0.1:8787`, web `127.0.0.1:5173`. Gates:
  `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (151 tests green at hand-off).
- Read first, in this order: `CLAUDE.md` (commands, conventions, gotchas), `STATUS.md` (what each
  milestone delivered and how it was verified), `ARCHITECTURE.md` §3–§4 and §8 (verified SDK facts,
  event → behaviour mapping, front-end structure), `apps/web/src/game/types.ts` (the `World` contract),
  `ASSETS.md`, `docs/history/BRIEF.md` (the original brief; its working rules still apply).
- Monorepo: `packages/shared` (zod schemas, pure `mapEventToBehavior`, furniture catalog, room editing),
  `apps/server` (Fastify, SQLite, the only package touching the SDK), `apps/web` (React + Zustand UI,
  PixiJS 8 renderer in `apps/web/src/game`).
- State on this machine: logged in with a Claude **Max** plan (subscription mode, no API key); four demo
  agents (Ada/Bob/Cy/Max) exist on the sample repo `~/.agenthotel/sample-repo`; ~290 events are in the
  SQLite log, which the **Replay tab can play back** — use replay to exercise animations at zero cost.

## How to work (unchanged rules, follow strictly)
1. Start in PLAN MODE: read the files above, then produce a short design note (append a §11 to
   ARCHITECTURE.md), a milestone plan (append to PLAN.md), a risk list, and at most 5 blocking questions.
   Decide sensibly otherwise and record decisions. Wait for "go".
2. Vertical slices; after each milestone: run it, test it, commit (`feat(gN): …`), 3-line note in
   STATUS.md. Never move on with a broken build.
3. Subagents for parallel work with strict file ownership: a "game" subagent owns `apps/web/src/game/**`
   and `apps/web/test/**`; the lead owns `packages/shared`, `apps/web/src/game/types.ts` (contract), UI,
   server, docs. Keep CLAUDE.md updated.
4. Verify, don't assume: check library versions on npm and read the installed typings before coding
   (Pixi 8.22, React 19.3, Vite 8, TS 5.9 pinned; Three.js / Babylon not yet installed).
5. Strict TypeScript, Biome, Vitest. Boring tech, no premature abstraction.

## The goal
High-polish 3D characters and furniture that still read instantly as "this agent is reading / typing /
running a command / asking for permission". Acceptance:
- Characters are 3D (modelled + rigged + animated), with smooth idle / walk / sit / type / read /
  raise-hand / celebrate / nap / sweat / cooldown states and 8-direction facing, customised from the
  existing `Avatar` DTO (skin, hair + style, shirt, pants, accessory) via material/mesh swaps.
- Furniture (desks, chairs, bookshelf, server rack, coffee machine, sofa, plants, whiteboard, library PC,
  door, rug) and the room (floor styles 0–4, wall styles 0–2) are 3D with soft shadows and lighting.
- Everything behind the **existing `World` contract** so the UI, editor, board drag-and-drop
  (`screenToTile` → `getAvatarAt`), replay and tests keep working unchanged. The Pixi renderer stays
  selectable (`VITE_RENDERER=pixi|three`) until the 3D one is at parity.
- 60 fps on this MacBook Air (Apple Silicon) with 6 agents + 2 interns; bundle growth justified.
- No Habbo assets, names or logos. Every model, texture, animation and font recorded in ASSETS.md with
  its license (CC0 preferred: Kenney, Quaternius, KayKit; check Mixamo-style licences before use).

## Recommended approach (decide in plan mode, justify changes)
Real-time 3D with **Three.js**: orthographic isometric camera matching the current tile maths
(64×32 screen ratio ≈ 30° elevation, 45° yaw), glTF characters with skeletal animation and an animation
state machine driven by the existing `Behavior` union, outfit customisation via material colour slots and
hair/accessory mesh variants, instanced furniture, PCF soft shadows, SSAO + light bloom only if frame
budget allows. Alternative to weigh: pre-rendered 3D → HD sprite sheets (the `sheet` manifest kind is
reserved for this) keeping Pixi. Suggested milestones:
- G0 plan + asset sourcing + licence check + renderer switch scaffold.
- G1 Three.js renderer implementing `World` for room + furniture + camera + picking (`screenToTile`,
  `getAvatarAt`, highlight/ghost for the editor).
- G2 characters: rig, animation state machine for every `Behavior`, outfit customisation, interns.
- G3 bubbles/emotes/labels in 3D (billboards), lighting/shadows, replay + editor parity, performance pass.
- G4 polish: transitions, camera easing, idle variety, new GIF, docs (ASSETS.md, README, ARCHITECTURE).

## Gotchas learned so far
- `pnpm dev` runs the server under `tsx watch`: editing `apps/server` or `packages/shared` restarts the
  server and kills live agent processes. Graphics work should not need live agents — use Replay.
- Hot-reloading `world.ts` leaves a stale mounted world; reload the page. The store module forces a
  full reload on hot update on purpose.
- Browser pane: use `find` + `ref` for clicks (coordinate clicks were off by the screenshot scale).
- The Zustand store must return stable references from selectors (`useShallow`).
- dnd-kit drops onto avatars go through `World.screenToTile` and `World.getAvatarAt`: the new renderer
  must implement both against its own camera.
- Costs in the HUD are SDK API-equivalent estimates; dev runs on the Max plan are approved (Sonnet,
  short prompts, ≤ 2 concurrent) but graphics work should avoid them.

## Also pending from the last session
The owner wanted to try the app with a real repository: HR desk → New agent → Working directory =
absolute path of the repo (tick "git worktree" to keep their checkout clean) → assign a task from the
board. Offer this once the plan is approved, or do it first if asked.
