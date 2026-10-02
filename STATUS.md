# Status notes

One 3-line note per milestone, newest first.

## M0 — scaffold (2026-10-02)

1. Monorepo (pnpm 10.34.5 pinned, TS 5.9, Biome 2, Vitest 5) with shared schemas, `mapEventToBehavior` + 23 tests, Fastify/WS server skeleton, Vite/React web skeleton; `pnpm dev` starts both and the Vite proxy reaches `/api/health`.
2. Gates green: typecheck, lint, test, web build. Agent SDK 0.3.287 installed with its 228 MB darwin-arm64 binary; better-sqlite3 compiled from source (~2 min) on Node 22.22.
3. Next: M1 isometric room + click-to-walk (game subagent), while the lead prepares M2 auth providers and the SDK adapter.
