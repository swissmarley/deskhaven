# Status notes

One 3-line note per milestone, newest first.

## G0 — graphics phase: plan, assets, renderer switch (2026-10-03)

1. Plan approved (ARCHITECTURE §11, PLAN.md phase 2, 4 questions answered): Three.js 0.186.1 behind the existing `World` contract with one simulation core and two scene backends (G1). `createWorld()` now returns a `LazyWorld` that dynamically imports the backend chosen by `VITE_RENDERER` or `localStorage['agenthotel.renderer']` (Pixi default; entry bundle 334 kB, Pixi world chunk 27 kB, Three world chunk 546 kB / 137 kB gzip, both lazy). New pure modules + tests: `pose.ts`, `camera.ts` over `CameraView`, `renderer.ts`, `lazy-world.ts` (StrictMode races), `three/camera.ts` (projection proven equal to `iso.tileToScreen` within 0.01 px).
2. Assets (all CC0, ASSETS.md): KayKit Adventurers `Rogue.glb` (41-joint rig, per-part skinned meshes, hand-slot bones, 76 embedded clips incl. Idle/Walking/Sit_Chair/Lie/Cheer/Interact/Spellcast_Raise) and 14 Kenney Furniture Kit models converted OBJ → GLB (4–36 kB each) committed under `apps/web/public/models/` with licence texts; KayKit Character Animations, Quaternius UAL and KayKit Furniture Bits inspected and not used; `scripts/inspect-gltf.mjs` prints rigs/clips. Server SPA fallback now 404s file-like paths (test added). Verified in the browser: with the override set, the empty 3D room renders (instanced floor styles incl. the rug, north/west walls with skirting, hemisphere + shadow-casting sun) and the Pixi path is unchanged. Gates green: 177 tests (30 shared, 94 web + 2 skipped, 53 server).
3. Next: G1 — split `world.ts` into `WorldCore` + `Scene` port + `PixiScene` (FakeScene tests), then `ThreeScene` with glTF furniture, picking, editor parity and capsule avatars.

## M0 — scaffold (2026-10-02)

1. Monorepo (pnpm 10.34.5 pinned, TS 5.9, Biome 2, Vitest 5) with shared schemas, `mapEventToBehavior` + 23 tests, Fastify/WS server skeleton, Vite/React web skeleton; `pnpm dev` starts both and the Vite proxy reaches `/api/health`.
2. Gates green: typecheck, lint, test, web build. Agent SDK 0.3.287 installed with its 228 MB darwin-arm64 binary; better-sqlite3 compiled from source (~2 min) on Node 22.22.
3. Next: M1 isometric room + click-to-walk (game subagent), while the lead prepares M2 auth providers and the SDK adapter.

## M1 — isometric room + click-to-walk (2026-10-02)

1. PixiJS 8 world behind the `World` contract: 64×32 iso maths, walkability grid, A* (8-dir, no corner cutting), station resolution from the furniture catalog, placeholder art, bubbles, poses, camera (zoom/pan), 31 pure-module tests; game subagent owned `apps/web/src/game`.
2. Verified in the browser: room renders with walls, 6 desks, bookshelf, racks, sofa, rug; clicking a tile walks the avatar around furniture. Fixed a layout bug the subagent found (rack-2 covered rack-1's stand tile) with a shared regression test.
3. Next: M2 real agent — server runtime, auth providers, normaliser and UI are written and tested (92 tests total); verifying a live Sonnet session in subscription mode.

## M2 — auth providers, one real agent, live events (2026-10-02)

1. Server: `AuthProvider` (API_KEY via env/keychain, CLAUDE_SUBSCRIPTION via the bundled CLI's `auth status` probe, env scrubbing, loopback-only), SDK adapter in streaming-input mode with hooks + `canUseTool`, pure normaliser (`SDKMessage`/hooks → `AgentEvent`), per-agent runtime, concurrency-capped manager, permission broker, SQLite event store, REST + WS snapshot; web: store with `mapEventToBehavior`, HUD usage meter, HR desk, inspector, feed, settings, permission modal.
2. Verified live on this Mac in subscription mode (`apiKeySource: none`, Max plan): Ada (Engineer, Sonnet) read three files and answered; a second turn asked for Bash, the avatar raised a hand, the modal approved it once, `npm test` ran and the result streamed back. Recorded session saved as a normaliser fixture (118 messages). 93 tests green; first-run default picked subscription mode because no API key exists here.
3. Next: M3 multi-agent — HR desk polish, editable presets UI, worktrees (service + tests done), session resume check after restart, procedural avatar sprites.

## M3 — multi-agent, HR desk, persistence, resume (2026-10-02)

1. HR desk create/edit form with avatar picker (procedural 16×28 pixel sprites, 4 facings × 7 poses, generated at runtime by the game subagent and shown in the room), editable role presets (JSON editor, reset to shipped), git worktrees per agent (service + tests, dirty-check on removal, force from the UI), per-agent status/task/tokens/cost/tool history in the inspector.
2. Verified: three agents (Engineer, Reviewer, QA) hired on the sample repo; after a full server restart Ada's new process resumed her stored session and recalled earlier findings without re-reading files. Concurrency cap now counts busy agents (in a turn or waiting for permission), so idle processes do not block the third agent.
3. Next: M4 task board (service and routes already landed here as groundwork).

## M4 — task board, assignment, results, permission modal (2026-10-02)

1. Kanban drawer (Backlog → Done) with dnd-kit: cards drag between columns or onto an avatar in the room to assign; task detail modal with prompt, result, files changed, cost, reassign, nudge/reply, delete. Server `TaskService` moves tasks from agent events (working → in progress, permission → needs input, turn done → review) and captures result summary, cost and `git diff --numstat` files; tasks interrupted by a restart are re-dispatched (queued) or flagged (mid-turn).
2. Verified end to end in subscription mode: Ada fixed `mean()` (Edit diff recorded, `npm test` approved in the modal, 3/3 tests pass in the repo), Bob reviewed, Cy ran the tests with a second approval; all three landed in Review with summaries; a card was dragged to Done. 113 tests green (2 canvas-only tests skip under Node).
3. Next: M5 room editor + saved layouts.

## M5 — room editor, interaction points, saved layouts (2026-10-02)

1. Pure room-editing operations in shared (`placeFurniture`, `moveFurniture`, `rotateFurniture`, `removeFurniture`, `paintFloor`, `paintWall`, `validateRoom`, `resizeRoom`; 6 tests) drive a Room tab in the UI: click to place or paint, drag furniture to move, R rotates, Delete removes, ghost preview turns red when a placement would block another piece's access tile; layouts are validated and saved to SQLite (`RoomService`, PUT/reset/export/import), and desks that disappear clear the owning agent's desk. Game subagent added editor mode, drag/paint events, ghost rendering, furniture highlight, five floor and three wall styles, and `setRoom` re-settling (11 tests).
2. Verified in the browser: a plant placed on the rug, an invalid bookshelf move rejected with the reason, a valid move saved on the server, and Bob's next Read walked him to the bookshelf's new spot by the west wall.
3. Next: M6 manager, interns, budgets, kill switch (mostly landed with this batch).

## M6 — manager delegation, interns, budgets, kill switch, concurrency cap (2026-10-02)

1. Manager preset gets an in-process MCP server (`list_agents`, `create_task`, `assign_task`, `task_status`; flat delegation enforced, 3 tests); interns appear from `SubagentStart/Stop` hooks; per-agent and global daily caps (`BudgetGuard`, 3 tests) turn an assignment into Needs input with the reason; idle processes stop after a configurable timeout (sessions resumable); `strictMcpConfig` keeps the user's global MCP connectors out of agents.
2. Verified live: Max (Manager on Sonnet) called `list_agents` and `create_task` twice, Ada implemented `median()` with tests (9/9 pass) and Cy re-ran the suite; a $0.01 cap refused an assignment with a readable message; Ada's Explore subagent produced intern enter/leave events; the kill switch stopped a running turn in 0.8 s, refused new prompts, and left no Claude processes. 137 tests green.
3. Next: M7 polish — sounds, emotes, replay, onboarding, README GIF.

## M7 — polish: sounds, emotes, replay, onboarding, README (2026-10-02)

1. Replay tab plays any time range of the SQLite event log through the same store and `mapEventToBehavior` path (1×/4×/16×/64×, step, scrub, stop + resync); first-run wizard (auth mode with live probe and policy note → sample workspace → first hire) persists `onboarded`; synthesized WebAudio sound set with per-sound toggles and master volume; emote polish (thumbs-up, falling sweat drop, ticking cooldown, pulsing "!", rising z's, intern poof); heartbeat WebSocket client; README with setup, both auth modes and caveats, architecture and extension guides, plus `docs/demo.gif` captured from a live run.
2. Verified in the browser: 250 logged events replayed at 4× with avatars re-enacting them; the wizard walked through all three steps and closed; the GIF frames show Bob reading and reporting back. Gates green: 151 tests (2 canvas-only skipped), typecheck, lint, build.
3. Done: M0–M7. Follow-ups worth considering: multiple rooms in the UI (data model is ready), file-backed sprite sheets, worktree merge helper, per-agent cost history chart.
