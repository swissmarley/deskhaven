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
- Browser pane clicks: use `find` + `ref` (coordinate clicks were off by the screenshot scale factor).
- Dev verification runs use Sonnet in subscription mode against the owner's Max plan (approved
  2026-10-02): keep prompts short, concurrency ≤ 2.
