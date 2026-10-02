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
