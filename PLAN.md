# AgentHotel — Milestone plan

Written 2026-10-02. Companion to [ARCHITECTURE.md](ARCHITECTURE.md). Status: **building — M0–M4 done, M5 next** (see STATUS.md).

## Working agreement (from the brief)

- Vertical slices. Each milestone ends with: run it, test it, commit, 3-line status note in `STATUS.md`. Never move on with a broken build.
- Subagents for parallel work with explicit file ownership (see §Ownership). The lead owns `packages/shared`, root configs, docs, integration and commits.
- Verify, don't assume: the SDK adapter is coded against the installed `sdk.d.ts` (facts in ARCHITECTURE §3); the normaliser and `mapEventToBehavior` are unit-tested with recorded fixtures.
- Strict TypeScript everywhere; Biome for lint/format; Vitest for tests. No premature abstraction.

## Verification gate (every milestone)

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

plus a manual smoke run of `pnpm dev` in the browser, then `git commit` (conventional commits, e.g. `feat(m1): isometric room and click-to-walk`).

---

## M0 — Plan, scaffold, tooling (½ day)

Goal: an empty but fully wired monorepo where `pnpm i && pnpm dev` starts server and web, and all gates pass.

1. Fix the local toolchain: `corepack prepare pnpm@10.34.5 --activate`; pin `"packageManager": "pnpm@10.34.5"` in the root `package.json`; `engines.node >= 22`.
2. `git init` (branch `main`), `.gitignore`, `.editorconfig`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `biome.json`, root scripts: `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `clean`.
3. `packages/shared`: zod 4, first schemas (`AgentEvent`, `Behavior`, WS protocol), `mapEventToBehavior` stub + first test.
4. `apps/server`: Fastify 5 on `127.0.0.1:8787`, `/health`, `/ws` echo, zod validation, pino logger with redaction list.
5. `apps/web`: Vite 8 + React 19, proxy `/api` and `/ws` to the server, a page that shows WS connection state.
6. Docs: `CLAUDE.md` (commands, conventions, gotchas: `env` replaces, explicit `permissionMode`, `settingSources`, pnpm fix, 228 MB binary download, exact SDK pin), `ASSETS.md` stub, `STATUS.md`.

Acceptance: both processes start with one command; gates pass; first commit.

## M1 — Isometric room, one avatar walks (1 day)

1. `game/iso.ts`: tile ↔ screen maths for 64×32 tiles, depth key; unit tests.
2. Room model: 14×10 default grid, floor/wall painting data, a static layout JSON with desks, chairs, bookshelf, server rack, coffee machine, sofa, plants, whiteboard — all placeholder coloured boxes with labels.
3. Furniture catalog in shared (`kind` → footprint, rotations, interaction points `seat` / `stand-at`, facing) so M5 only adds the editor.
4. `game/pathfinding.ts`: A\* (8-dir, no corner cutting, furniture footprints block); unit tests.
5. Avatar placeholder (coloured box + name + facing marker), click-to-walk with tweening on the Pixi ticker, depth sorting, 4 facings.
6. Behaviour state machine on the avatar (`idle | walking | at_station`) ready to receive `Behavior` values; `mapEventToBehavior` fleshed out with the full table and tests, driven in M1 by a dev "fake event" dropdown.

Acceptance: click a tile, the avatar paths around furniture and faces the right way; fake "Read" event sends it to the bookshelf.

## M2 — Auth, one real agent, live events (2 days)

1. `AuthProvider` with `ApiKeyAuthProvider` (env → keychain via `@napi-rs/keyring`) and `ClaudeSubscriptionAuthProvider` (probe via bundled `claude auth status`; env scrub; loopback-only; cap 2; notice). Feature flag constant. Tests: env scrubbing keeps `PATH`/`HOME`, removes the three auth vars; key never appears in any serialised DTO or log line.
2. Settings: auth mode, flag state, concurrency cap; `GET /api/auth/status` returns only non-secret fields.
3. `sdk-adapter.ts` (the only file importing SDK types): `createAgentQuery()` with streaming-input push queue, `includePartialMessages`, `forwardSubagentText`, explicit `permissionMode`, `settingSources: ['project']`, hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart/Stop`, `Stop`, `PermissionDenied`, `SessionStart`), `canUseTool` → `PermissionBroker`.
4. `normalizeSdkMessage()` / `normalizeHook()` → `AgentEvent`; record real messages from one short Sonnet session (subscription mode, approved) into `fixtures/*.jsonl`; tests cover every message type we handle and assert unknown types become `unknown` events.
5. Event store (SQLite `events`, append-only) + WS broadcast; client store; the M1 avatar is bound to the agent and reacts via `mapEventToBehavior` (read / edit / bash / idle / thinking / permission).
6. Runtime check: in subscription mode `system/init.apiKeySource` must be `'none'`, else stop and surface an error.
7. Minimal permission approve/deny buttons in a side panel (full modal in M4); HUD usage meter (mode in use, tokens, estimated cost, plan windows from `rate_limit_event`); 401/429 → `error`/`rate_limit` events → sweat/cooldown emote + banner.
8. Dev-only "spawn test agent" + prompt box.

Acceptance: both modes probe correctly on this machine; a prompt such as "read the README and list the files" shows the avatar at the bookshelf, then thinking, then the result in the panel; cost appears in the HUD.

## M3 — Multi-agent, HR desk, persistence, resume (2 days)

1. Drizzle schema + migrations for all tables in ARCHITECTURE §7; `AGENTHOTEL_DATA_DIR`.
2. HR desk UI: create/edit agent (name, palette/outfit picker, role preset, system prompt, model from `supportedModels()`, tools, permission mode, workdir or repo + "use a git worktree").
3. Role presets as editable JSON (`packages/shared/presets/*.json`, seeded into SQLite): Architect (read-only, plan), Engineer (edit + bash asks), Reviewer (read-only), Researcher (web + read), QA (bash + tests).
4. `AgentManager`: semaphore for the concurrency cap, lifecycle spawn / pause / resume / stop / delete, `session_id` persisted, `resume` on restart, worktree service (`git worktree add`, dirty check on removal).
5. Procedural sprite sheets v1 (canvas-drawn pixel avatars from palette + outfit params) through the asset manifest; placeholder stays as fallback.
6. Per-agent view: status, current task, tokens, cost, tool-call history.

Acceptance: create 3 agents with different roles; stop the server; start again; an agent resumed with `resume` answers "what did you do earlier?" correctly.

## M4 — Task board, assignment, results, permission modal (2 days)

1. Tasks CRUD and Kanban (Backlog, Assigned, In Progress, Needs Input, Review, Done) with dnd-kit; drop onto an avatar (canvas droppable, pointer → tile → avatar) or assign via dropdown.
2. Assigning sends the prompt into the agent's stream; each `result` is attributed to the active task: result summary (last assistant text), files changed (`git diff --stat` in cwd, or tracked Edit/Write paths), cost, timestamps.
3. Full permission modal: allow once / allow for this session (`updatedPermissions` from `suggestions`) / deny with reason; persisted `permission_requests`; timeout → deny + Needs Input; raise-hand + sound.
4. Inspector: live transcript, tool calls, diffs (Edit from `old_string`/`new_string`, Write from a `PreToolUse` snapshot), task, cost; actions: send message, interrupt, pause, reassign desk.
5. Global activity feed (chat-log style) with sound toggle.

Acceptance (Definition-of-Done rehearsal): 3 agents, 3 tasks in the sample repo, avatars work visibly, one permission approved in the modal, results and diffs visible on the board and inspector.

## M5 — Room editor, interaction points, saved layouts (1 day)

1. Editor mode: place / move / rotate / delete furniture, paint floors and walls, grid snapping, collision with footprints.
2. Layouts saved to SQLite (`rooms`, `furniture`); default layout seeded; export/import JSON.
3. Desk ownership per agent; behaviours resolve stations from the live layout (nearest free bookshelf slot, own desk, any server rack…).

Acceptance: move the bookshelf, the next Read walks to the new position; reload keeps the layout.

## M6 — Manager delegation, interns, budgets, kill switch, cap (1½ days)

1. Manager preset: in-process MCP server (`createSdkMcpServer` + `tool()`) exposing `list_agents`, `create_task`, `assign_task`, `task_status`; flat delegation (employees never receive these tools); goal → tasks → assignment visible on the board.
2. Interns: `SubagentStart/Stop` + `task_started/notification` spawn temporary avatars that walk in from the door and leave on stop; nested transcript via `parent_tool_use_id`.
3. Budgets: per-agent `maxTurns` / `maxBudgetUsd` (SDK) and per-day caps (server `BudgetGuard`), global per-day cap, visible meters; exceeding → task to Needs Input with reason.
4. Kill switch: `interrupt()` then abort all, `killed` flag blocks new spawns, global banner.
5. Concurrency cap UI; queued agents shown as "waiting for a desk".

Acceptance: give the manager a goal; tasks appear and get assigned; kill switch stops everything within ~2 s; budget breach is visible.

## M7 — Polish (1½ days)

1. WebAudio sounds (tool start, permission, done, error) with per-sound toggles; emote set complete (sweat, thumbs-up, confetti, zzz, cooldown).
2. Replay mode: play back `events` for a time range at 1×/4×/16× through the same `mapEventToBehavior`; scrubber.
3. Onboarding: first-run wizard (auth mode with policy notice and date — preselects subscription when logged in and no key exists, both modes always offered; data dir; sample repo setup; create first agent).
4. README (setup, both auth modes and caveats, architecture, how to add roles / furniture / behaviours), GIF recorded from the running app, `ASSETS.md` with licenses, final policy re-check and date bump in ARCHITECTURE §5.1.

Acceptance: the Definition of Done from the brief passes end-to-end in both auth modes (API_KEY mode requires a key to be present).

---

## Ownership (for subagents)

| Owner | Paths |
|---|---|
| lead (me) | `packages/shared/**`, root configs, `CLAUDE.md`, `ARCHITECTURE.md`, `PLAN.md`, `STATUS.md`, `README.md`, integration, commits |
| server agent | `apps/server/**` |
| game agent | `apps/web/src/game/**`, `apps/web/public/assets/**`, `ASSETS.md` |
| ui agent | `apps/web/src/ui/**`, `apps/web/src/state/**`, `apps/web/src/net/**` |

Rule: schema changes in `packages/shared` go through the lead first; consumers adapt. No agent edits another owner's paths; cross-cutting changes are requested in the status note.

## Sample repo

`examples/sample-repo/`: a tiny TypeScript CLI (3–4 files, a README, a test, two planted TODOs and one bug) copied into `~/.agenthotel/sample` on first run and `git init`-ed, so the Definition-of-Done scenario works out of the box. Any other path can be used instead.

## Decisions taken without asking (recorded, reversible)

- Biome instead of ESLint + Prettier; TypeScript 5.9 instead of 7.x; `@napi-rs/keyring` instead of `keytar`; WebAudio-synthesised sounds; own A\*; manager delegation via in-process MCP tools; data in `~/.agenthotel`; server binds loopback in both modes by default; `settingSources: ['project']` by default; `bypassPermissions` never exposed.

## Resolved questions (answered 2026-10-02)

1. **Sample repo** — bundle `examples/sample-repo`, a tiny TypeScript CLI, copied into `~/.agenthotel/sample` on first run.
2. **Default models** — employees `claude-sonnet-5-5`, Manager `claude-opus-5-5`; selectable per agent from `supportedModels()`.
3. **Auth mode** — API_KEY stays the documented product default, but subscription mode must **always** be available to the user: the feature flag defaults on, Settings always lists both modes, and the first-run wizard preselects subscription when the probe says "logged in" and no API key exists (the only mode that works on such a machine). The policy notice and check date are shown next to the switch.
4. **Permission ceiling** — `bypassPermissions` is never exposed; the maximum is `acceptEdits` plus per-role `allowedTools`. Engineer preset auto-allows Edit/Write and asks for Bash.
5. **Development spending** — approved: verification runs from M2 on use **Sonnet** sessions in subscription mode against the user's Max plan (short prompts, concurrency 1–2). No API key will be provided for dev.
