# Contributing to Deskhaven

Thanks for helping. Start with the [guide](docs/GUIDE.md) to get the app running, then:

## Workflow

```bash
pnpm i
pnpm dev                                                  # server :8787 + web :5173
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # the gate; CI runs the same
```

- Open a pull request against `main` with the gate green. Keep changes focused: one concern per PR.
- Commits are conventional (`feat(scope): …`, `fix(server): …`, `docs: …`, `chore: …`).
- Strict TypeScript, ESM with `.js` extensions on relative imports, Biome for formatting and linting
  (`pnpm lint:fix`), Vitest for tests. Validate every boundary with zod (REST bodies, WebSocket messages,
  SDK output).
- Secrets are never logged, serialised or persisted. Do not commit keys, `.env` files or databases.

## Where things live

- `packages/shared`: schemas, `mapEventToBehavior`, furniture catalog, presets. Pure, no I/O.
- `apps/server`: the only code that imports the Agent SDK (`src/agent/sdk-adapter.ts` for its types).
- `apps/web`: React UI; the world under `src/game` (`core/` is renderer-agnostic, `three/` and `pixi/` are
  the two renderers behind the `Scene` port).
- [ARCHITECTURE.md](ARCHITECTURE.md) explains the decisions and the verified SDK facts;
  [CLAUDE.md](CLAUDE.md) lists commands and gotchas (read it before touching the SDK adapter or the
  renderers); [PLAN.md](PLAN.md) and [STATUS.md](STATUS.md) record the milestones.

## Tips

- Use the **Replay** tab to exercise animations and UI states without running agents (no cost).
- Editing `apps/server` under `pnpm dev` restarts the server and ends live agent processes.
- Adding art: only CC0 (or your own) assets, with an [ASSETS.md](ASSETS.md) row (source URL, licence,
  transformation) for every file. No third-party game assets or trademarks.
- Adding a role, furniture kind or behaviour: see "Extending" in the [README](README.md).
