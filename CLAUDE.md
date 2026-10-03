# AgentHotel — working notes for Claude Code

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
pnpm start             # production server (serves apps/web/dist when AGENTHOTEL_WEB_DIST is set)
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
- `result.total_cost_usd` is an estimate and includes subagents; `result.usage` is main-loop only.
- pnpm: this machine's corepack shim pointed at a missing pnpm; `corepack prepare pnpm@10.34.5 --activate`
  fixes it. `packageManager` is pinned in the root `package.json`.
- pnpm 10 blocks lifecycle scripts; `better-sqlite3` and `esbuild` are allow-listed in
  `pnpm.onlyBuiltDependencies`.
- Record real SDK traffic for fixtures with `AGENTHOTEL_RECORD_SDK=/path/to/file.jsonl pnpm dev`; the
  normaliser test replays every `apps/server/test/fixtures/*.jsonl` file.
- The sample repo (`examples/sample-repo`) is copied to `~/.agenthotel/sample-repo` by `POST /api/sample/init`;
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
  `localStorage['agenthotel.renderer']` overrides it at runtime. `createWorld()` returns a `LazyWorld`
  that queues calls until the backend is dynamically imported in `mount()`; Pixi stays the default
  until the G3 parity commit. See ARCHITECTURE.md §11.
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
