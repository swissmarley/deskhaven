# Status notes

One 3-line note per milestone, newest first.

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
