# Deskhaven — working notes for Claude Code

Isometric pixel-art office where every avatar is a real Claude Code agent driven through
`@anthropic-ai/claude-agent-sdk`. Read [ARCHITECTURE.md](ARCHITECTURE.md) for decisions and
[PLAN.md](PLAN.md) for the milestone plan; [STATUS.md](STATUS.md) says where we are.

## Commands

```bash
pnpm i                 # once; downloads the SDK's ~228 MB native claude binary (needs network)
pnpm dev               # server on 127.0.0.1:8787 + web on 127.0.0.1:5173 (Vite proxies /api and /ws)
pnpm typecheck         # tsc --noEmit in every package
pnpm lint              # biome check .   (pnpm lint:fix / pnpm format to auto-fix)
pnpm test              # vitest run in every package
pnpm build             # typecheck + vite build for the web app
pnpm start             # production server (serves apps/web/dist when DESKHAVEN_WEB_DIST is set)
```

Gate before every commit: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## Layout

- `packages/shared` — zod schemas (`AgentEvent`, DTOs, WS protocol), `mapEventToBehavior`, furniture
  catalog, role presets (JSON), default room. Pure, no I/O. Consumed as TypeScript source
  (`exports: ./src/index.ts`), so there is no build step.
- `apps/server` — Fastify 5 + WebSocket, SQLite (better-sqlite3 + Drizzle), the only package that imports
  the Agent SDK (`src/agent/sdk-adapter.ts` is the only file that imports SDK *types*).
- `apps/web` — Vite + React 19 UI panels, PixiJS 8 canvas in `src/game`, Zustand store in `src/state`.

## Conventions

- Strict TypeScript, `noUncheckedIndexedAccess`, ESM everywhere, `.js` extensions on relative imports.
- Validate every boundary with zod: REST bodies, WS messages in both directions, SDK output → `AgentEvent`.
- One pure function maps events to behaviours (`packages/shared/src/behavior.ts`); the game never
  inspects raw SDK data.
- Secrets: never log, never serialise, never persist. The logger redacts `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKey`, `token`.
- Commits: conventional (`feat(m2): ...`, `fix(server): ...`). One commit per milestone minimum.
- File ownership when subagents run: lead owns `packages/shared` + root docs; server / game / ui agents own
  their directories (see PLAN.md).

## Gotchas (verified against the installed SDK 0.3.287)

- Zustand selectors must return stable references: wrap array/object-producing selectors in `useShallow`
  (or select primitives). A fresh array per call makes React loop ("getSnapshot should be cached").
- Real sessions also emit `system/status`, `system/task_summary` and `system/post_turn_summary`; the
  normaliser ignores unknown `system` subtypes on purpose (no `unknown` event, nothing persisted).

- `Options.env` **replaces** the subprocess environment. Always spread the base env; strip
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` in subscription mode.
- Omitting `permissionMode` yields the CLI's default ("auto" where available), not "ask". Always pass it.
- `bypassPermissions` needs `allowDangerouslySkipPermissions`; we never set either.
- `strictMcpConfig: true` is always passed: without it the user's global MCP servers (from `~/.claude.json`)
  load into every agent, which a live run showed (a subagent listed the user's connectors).
- `settingSources` must include `'project'` to load the target repo's `CLAUDE.md`; we default to
  `['project']` so the user's global settings cannot change agent behaviour.
- The SDK spawns its own bundled `claude` binary (platform package), not the one on PATH. Subscription
  credentials are read because the SDK does not pass `--bare`; re-verify on every SDK upgrade
  (`grep -c '"--bare"' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` should print 0) and
  check that `system/init.apiKeySource === 'none'` in subscription mode.
- `system/init` carries `session_id`; every message does. Persist `session_id` and pass `resume`.
- `result.total_cost_usd` is an estimate, includes subagents and is **cumulative per process** (resumed
  processes continue from the saved total); the runtime differences it per turn (`turn_completed.costUsd`,
  raw total in `sessionCostUsd`). `result.usage` is main-loop only and per turn.
- "Max $ / turn" (`budget.maxBudgetUsd`) is enforced by `AgentRuntime` and no longer passed to the SDK
  (whose cap is cumulative per process). It stops at the larger of its own estimate (`agent/turn-cost.ts`,
  from `message_start`/`message_delta`/assistant usage) and the SDK's running total read mid-turn through
  the experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (null-safe).
- `turn-cost.ts` mirrors the price catalog **of the bundled `claude` binary**, not the public price list,
  because every cap and total uses the SDK's figure. SDK 0.3.287 does not know `claude-haiku-5-5` and
  prices it (like any unknown id) at its default model's rate, Sonnet 5.5 ($2/$10, 1h cache write $4,
  read $0.20): Haiku 5.5 turns are reported ~20x above list price. Re-check on every SDK upgrade:
  `strings $(find node_modules/.pnpm -path '*claude-agent-sdk-linux-x64*' -name claude -type f) | grep -o 'tier_[0-9a-z_]*:{input:[^}]*}'`
  and the `{id:"claude-…",…pricing:"tier_…"}` catalog entries.
- Stored turn costs before 2026-10-31 were cumulative; `db/cost-migration.ts` rewrote them once at boot
  (settings key `migration.turn_cost_per_turn`) and corrected task, agent and daily totals.
- Office totals in the header (today and all time) sum `usage_daily`, which keeps the rows of fired
  agents; the HR list shows each agent's cost today and a line for agents no longer on staff.
- Every task of an agent shares one worktree and branch. The merge preview names the task that ran last
  there (`ownerTask`); a done task whose branch holds another task's work offers no merge (409
  `changes_belong_to_other_task` on the API).
- An agent's `tools: null` means its preset's list; the Engineer preset now ships Read, Edit, Write,
  Bash, Glob, Grep (the whole Claude Code surface cost ~95k tokens per new session).
- The SDK prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` at every spawn: bare `allowedTools` names skip
  `canUseTool`. Intended: `allowedTools` is the auto-approve list; the workdir edit guard is a
  `PreToolUse` hook and still runs for them.
- pnpm: this machine's corepack shim pointed at a missing pnpm; `corepack prepare pnpm@10.34.5 --activate`
  fixes it. `packageManager` is pinned in the root `package.json`.
- pnpm 10 blocks lifecycle scripts; only `esbuild` is allow-listed in `pnpm.onlyBuiltDependencies`.
  `better-sqlite3` is in `ignoredBuiltDependencies` on purpose: it loads its prebuilt N-API binary
  (linux/darwin/win32, x64/arm64, glibc+musl), and running its install script made node-gyp require
  `make`/`g++` on Linux for nothing. Other platforms: `pnpm rebuild better-sqlite3` with a toolchain.
- Every request passes `apps/server/src/http/security.ts`: Host allow-list, Origin/Referer on writes and
  `/ws`, JSON-only writes, per-launch session token (cookie from `GET /api/session`). Server tests use
  `test/helpers.ts` (`client(built)` adds the headers); `curl` needs `-H 'Host: 127.0.0.1:8787'`-style
  loopback hosts plus `X-Deskhaven-Token` (set `DESKHAVEN_SESSION_TOKEN` for scripted runs).
- Credentials are captured per process: when the auth provider changes, an idle runtime restarts its
  process (same session id) before dispatching the next prompt.
- API_KEY mode without `ANTHROPIC_API_KEY` refuses to spawn unless `auth/external.ts` recognises other
  configured credentials (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`, a project `apiKeyHelper`, or
  `DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS=1`); the same object decides which `apiKeySource` values pass.
- Record real SDK traffic for fixtures with `DESKHAVEN_RECORD_SDK=/path/to/file.jsonl pnpm dev`; the
  normaliser test replays every `apps/server/test/fixtures/*.jsonl` file.
- The sample repo (`examples/sample-repo`) is copied to `~/.deskhaven/sample-repo` by `POST /api/sample/init`;
  its tests run with Node's `--experimental-strip-types` and a quoted glob (`--test 'test/*.test.ts'`).
- `pnpm dev` runs the server under `tsx watch`: **editing any server file restarts it and kills every live
  agent process** (sessions stay resumable; queued tasks re-dispatch, mid-turn tasks go to Needs input).
  Don't edit `apps/server` while a live verification run is in progress.
- The concurrency cap counts *busy* agents (in a turn or waiting on a permission). Idle processes stay alive
  for resume and do not occupy a desk.
- `allowedTools` rules such as `Bash(npm test:*)` only match simple commands; a compound command
  (`npm test 2>&1; echo ...`) falls through to the permission modal. That is intended.
- The Zustand store module forces a full page reload on hot update (a second store copy would desync the
  Pixi bridge). Editing `world.ts` while the page is open leaves a stale mounted world: reload the page.
- Replay feeds logged events through the same store path as live traffic; while replaying, live `event`
  messages are dropped and a `hello` resync follows `stopReplay()`.
- GIF for the README: `docs/demo.gif` was assembled from browser-pane screenshots with Pillow
  (`python3` + `PIL`); ffmpeg is also available on this machine.
- Browser pane clicks: use `find` + `ref` (coordinate clicks were off by the screenshot scale factor).
- Dev verification runs use Sonnet in subscription mode against the owner's Max plan (approved
  2026-10-02): keep prompts short, concurrency ≤ 2.

## Graphics phase (G0–G4) notes

- Two renderers behind the same `World` contract: `VITE_RENDERER=pixi|three` at build/dev time,
  `localStorage['deskhaven.renderer']` overrides it at runtime. `createWorld()` returns a `LazyWorld`
  that queues calls until the backend is dynamically imported in `mount()`; `three` is the default
  since G3, `VITE_RENDERER=pixi` or the Settings selector brings the pixel-art path back. `?stats=1`
  shows fps / draw calls / triangles in the Three renderer. See ARCHITECTURE.md §11.
- 3D models live in `apps/web/public/models/` (CC0, licences in `models/licenses/`, one ASSETS.md row
  per file). Inspect any glb/gltf with `node scripts/inspect-gltf.mjs file.glb` (nodes, meshes,
  materials, skins, clip names). Kenney furniture was converted with `npx obj2gltf -i x.obj -o x.glb`.
- The production SPA fallback returns 404 for file-like paths (`/models/x.glb`), so a missing model
  fails cleanly instead of being parsed as `index.html`.
- Three core classes (`OrthographicCamera`, `Vector3`) work in vitest under Node; `three/addons/*`
  may touch the DOM, so keep them out of modules imported by tests.
- zsh: never `echo =====` unquoted (zsh expands `=word` as a command path); quote separators.
- Graphics work uses the Replay tab (≈290 logged events); no live agent runs are needed.
- `three/scene.ts` must only be reached through the dynamic import in `game/renderer.ts`; a static
  import anywhere under `game/index.ts` would pull the ~546 kB Three chunk into the entry bundle.
- Three 0.186 removed `PCFSoftShadowMap` (logs a warning and falls back); use `PCFShadowMap` (or VSM).
- In the Three renderer, pan is a frustum shift (`left/right/top/bottom`), not a camera move: the camera
  stays at `VIEW_DIR × 100` looking at the origin, so shadow-camera fitting is independent of pan/zoom.
- `LazyWorld` queues calls only while a mount is pending; calls made after `destroy()` and before the
  next `mount()` are dropped on purpose (a never-remounted world cannot leak).
- Browser pane: if the app looks collapsed (canvas 1 px wide), the pane's responsive width shrank;
  `resize_window` to 1280×800 before screenshots and reset to `desktop` afterwards.
- The desktop browser pane reports `document.hidden === true` whenever the pane is not frontmost
  (screenshots still work). Never gate rendering on `document.hidden`/`visibilitychange`: the Three
  loop did and showed a black canvas; browsers already throttle `requestAnimationFrame` when hidden.
- Debugging the live world from the browser pane: `const w = (await import('/src/ui/worldHandle.ts')).getWorldHandle()`;
  `w.inner` is the `WorldCore`, `w.inner.scene` the mounted scene (Three: `.renderer`, `.iso.camera`).
- Avatar previews: the UI imports the 3D preview only through `game/preview.ts` (a lazy wrapper);
  never import `three/preview.ts` statically from `game/index.ts` or the Three chunk lands in the entry.
  The picker falls back to the pixel sprite when the 3D render resolves `null`.
- `three/merge.ts` (BufferGeometryUtils) and `three/preview.ts` must stay out of modules that tests
  import; pure helpers live in `preview-math.ts`, `door-math.ts`, `anim.ts`.
- Camera zoom/fit ease over `EASE_MS` (180 ms) via `camera.tick()` from `WorldCore.step`; the fit on
  mount snaps so the first paint is framed. The door leaf hinges at its +X edge and opens +80° inwards
  (model +Z = into the room at every rotation because of the manifest's `yawOffset = π/2`).
- Bundling: never `import()` a game module from the UI that `game/index.ts` also re-exports (e.g.
  `game/preview.ts`): Rollup then merges the two graphs and 190 Pixi modules land in the entry chunk
  (416 kB → 658 kB). Import the lazy wrappers statically; only the wrappers themselves `import()`
  the Three modules. Check `pnpm build`: entry ≈ 416 kB, Three core in a lazy `lights-*.js` chunk.
- Rename compatibility (AgentHotel → Deskhaven, 2026-10-03): env vars are read as `DESKHAVEN_*` with
  `AGENTHOTEL_*` as fallback (`envVar()` in `apps/server/src/config.ts`); the data dir defaults to
  `~/.deskhaven` but an existing `~/.agenthotel` (and its `agenthotel.db`) keeps being used until the
  new one exists, because worktree paths in the DB are absolute; browser storage reads
  `deskhaven.*` then `agenthotel.*`. The manager MCP tools are now `mcp__deskhaven__*`; the recorded
  fixture still contains the old tool names on purpose.
