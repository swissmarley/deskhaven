# Deskhaven — Architecture

Status: **planning draft, questions resolved (see PLAN.md), awaiting "go"**. Written 2026-10-02. Nothing in `apps/` or `packages/` exists yet.

Deskhaven is a local-first, browser-based isometric "office" where every avatar is a real Claude Code
agent driven through `@anthropic-ai/claude-agent-sdk`. This document records the decisions, the
rationale, the facts verified against the installed SDK, the auth-policy findings, the data model, and the
risk list. The milestone plan and open questions live in [PLAN.md](PLAN.md).

---

## 1. Decisions at a glance

| Area | Decision | Why (short) |
|---|---|---|
| Repo | pnpm workspaces: `apps/web`, `apps/server`, `packages/shared` | Brief default; three packages is enough, no Turbo/Nx yet |
| Language | TypeScript **5.9.x**, `strict` + `noUncheckedIndexedAccess` everywhere | TS 7.x is on npm but typescript-eslint/Vite tooling peer-ranges stop at 6.x; 5.9 is the boring choice |
| Lint/format | **Biome 2** (one binary for lint + format), `tsc --noEmit` for types | One tool, one config, no plugin matrix; types are enforced by tsc anyway |
| Tests | **Vitest 5** in every package | Native Vite integration, fast, one runner for shared/server/web |
| Web | React 19 + Vite 8, **PixiJS 8** (imperative, no `@pixi/react`), **Zustand 5**, `@dnd-kit/core`, CSS Modules | Brief defaults; `@pixi/react` adds an abstraction layer we don't need and churns with Pixi majors |
| Server | **Fastify 5** + `@fastify/websocket`, **zod 4**, **better-sqlite3 13** + **Drizzle 0.45** | Brief defaults; zod 4 is also the SDK's peer requirement |
| Agent engine | `@anthropic-ai/claude-agent-sdk` **pinned exact** (0.3.287 today); one `query()` in streaming-input mode per agent | Verified against installed `sdk.d.ts`, see §3 |
| Keychain | **`@napi-rs/keyring`** instead of `keytar` | `keytar` is archived/unmaintained (last release 2022) with no prebuilds for current Node; `@napi-rs/keyring` ships prebuilt darwin-arm64/x64, linux, win32 binaries |
| Sounds | Synthesised with WebAudio (oscillators/noise), no audio files | Zero licensing surface, zero asset weight; toggleable |
| Art | Placeholder (coloured iso boxes + labels) first; then procedurally generated 16×28 pixel sprite sheets (4 facings × 7 poses) from the `Avatar` DTO; single `assets/manifest.ts` with `placeholder` / `generated` / `sheet` kinds | Brief requirement; lets the game loop ship in M1 |
| Pathfinding | Own A\* on the tile grid (8-dir, no corner cutting), ~80 lines, unit-tested | Grid is ≤ 30×30; a dependency would be heavier than the code |
| Delegation | Manager agent gets an **in-process MCP server** (`createSdkMcpServer` + `tool()`) with `create_task`/`assign_task`/`list_agents`/`task_status`; employees never get these tools | Structured, flat, one level — no text parsing, and the SDK can't nest subagents beyond its own limits anyway |
| Data dir | `~/.deskhaven/` (SQLite db, git worktrees, logs); override with `DESKHAVEN_DATA_DIR` | Keeps the repo clean and makes "delete everything" one command |
| Models | Employees default to `claude-sonnet-5-5`, Manager to `claude-opus-5-5`; per-agent override from `supportedModels()` | Agreed 2026-10-02; balances plan usage against delegation quality |
| Ports | server `127.0.0.1:8787` (REST + `/ws`), web `5173` with Vite proxy to the server | Single origin in dev, no CORS; prod build is served by the server |

---

## 2. System shape

```
┌──────────────────────── browser (apps/web) ────────────────────────┐
│  React panels (HR desk, Task board, Inspector, Feed, Settings, HUD) │
│  Zustand store  ◄── WS client (zod-validated ServerMessage) ──────┐ │
│      │ subscribe                                                   │ │
│  WorldController ──► PixiJS scene: tiles, furniture, avatars,      │ │
│      │ mapEventToBehavior(event) (packages/shared, pure)           │ │
│      └► A* paths, tweens, bubbles, emotes, depth sort              │ │
└────────────────────────────────────────────────────────────────────┼─┘
                                                                     │ ws://127.0.0.1:8787/ws
┌──────────────────────── server (apps/server) ───────────────────────┼─┐
│  Fastify: REST (agents, tasks, rooms, settings, replay) + WS hub    │ │
│  AgentManager ── AgentRuntime (one per agent) ───────────────────── │ │
│      │  query({ prompt: pushQueue, options })  ← AuthProvider.env   │ │
│      │  hooks + canUseTool + SDK messages → normalizeSdkMessage()   │ │
│      ▼                                                               │ │
│  AgentEvent (zod) ─► SQLite events (append-only) ─► broadcast ──────┘ │
│  PermissionBroker (pending canUseTool promises ⇄ UI modal)            │
│  TaskService, RoomService, BudgetGuard, KillSwitch, WorktreeService    │
└──────────────────────────────────────────────────────────────────────┘
                     │ spawns one Claude Code subprocess per agent (bundled binary)
                     ▼
            agent cwd / git worktree (sandbox boundary)
```

Principles:

- **The server is the only process that touches the SDK or credentials.** The browser never sees env vars, keys, or raw SDK messages — only validated `AgentEvent`s and DTOs.
- **Events are the source of truth.** Every SDK message / hook is normalised into one typed `AgentEvent`, persisted, then broadcast. Live view, inspector transcript, feed and replay all consume the same stream; the game maps events to behaviours with one pure function.
- **No premature abstraction.** One runtime class per agent, plain modules for services, Zustand slices per domain, no DI container, no event-sourcing framework.

---

## 3. Agent SDK: verified facts (read from `@anthropic-ai/claude-agent-sdk@0.3.287` `sdk.d.ts`, 2026-10-02)

These are the exact names we will code against. Where the installed types and the public docs differ, the installed types win and the adapter layer (`apps/server/src/agent/sdk-adapter.ts`) is the only file that imports SDK types.

**Packaging.** The npm package is ~5 MB of JS plus an **optional platform dependency** (`@anthropic-ai/claude-agent-sdk-darwin-arm64` etc.) that contains a **228 MB native `claude` binary** (CLI 2.1.287 in this release). The SDK spawns that binary; it does not use the user's globally installed `claude` (2.1.280 here). Consequence: first `pnpm i` needs network; runtime needs none beyond the Anthropic API. The peer deps are `zod ^4`, `@modelcontextprotocol/sdk ^1.29`, `@anthropic-ai/sdk >=0.93`.

**Entry point.** `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`. `Query` is an `AsyncGenerator<SDKMessage>` with control methods:
`interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`, `streamInput(stream)`, `accountInfo()`, `initializationResult()`, `getContextUsage()`, `supportedModels()`, `rewindFiles()`, `stopTask()`, `close()`. There is also `startup()`/`prewarm()` for warm processes (not needed for v1).

**Options we will use** (all exist with these exact names):
`cwd`, `model`, `systemPrompt` (`string | { type:'preset', preset:'claude_code', append? }`), `tools` (restrict the tool set: `string[]`), `allowedTools` (auto-approve), `disallowedTools`, `permissionMode`, `canUseTool`, `hooks`, `resume`, `forkSession`, `sessionId`, `persistSession` (default `true`), `maxTurns`, `maxBudgetUsd`, `env`, `includePartialMessages`, `forwardSubagentText`, `settingSources`, `agents`, `mcpServers`, `strictMcpConfig`, `abortController`, `stderr`, `effort`, `additionalDirectories`.

Gotchas confirmed in the type docs:

1. **`env` REPLACES the subprocess environment** — it is not merged. We must spread `process.env` ourselves. This is exactly where the auth strategy injects or strips keys.
2. **`permissionMode` omitted ≠ `'default'`.** When omitted the CLI picks `permissions.defaultMode` from loaded settings, else `'auto'` (a model classifier). We always pass an explicit mode; `'default'` is required for `canUseTool` to be consulted on dangerous tools.
3. **`'bypassPermissions'` requires `allowDangerouslySkipPermissions: true`.** Deskhaven never sets it (see §6). The most permissive combination we expose is `acceptEdits` + role `allowedTools`.
4. **`settingSources` must include `'project'` to load the target repo's `CLAUDE.md`.** Default when omitted is all sources (user + project + local). We default to `['project']` so the user's global `~/.claude/settings.json` (which may contain `apiKeyHelper`, MCP servers, permission rules) cannot silently change an agent's behaviour; configurable per agent.
5. **`PermissionMode`** = `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.

**Permission callback.** `canUseTool(toolName, input, { signal, suggestions?, blockedPath?, decisionReason?, title?, displayName?, description?, toolUseID, agentID?, requestId, ... }) => Promise<PermissionResult | null>` where
`PermissionResult = { behavior:'allow', updatedInput?, updatedPermissions? } | { behavior:'deny', message, interrupt? }`. `title`/`displayName`/`description` are pre-rendered prompt strings we can show verbatim in the modal; `suggestions` is the list to echo back as `updatedPermissions` for "always allow (this session)".

**Hooks.** `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`, `HookCallbackMatcher = { matcher?: string, hooks: HookCallback[], timeout? }`, `HookCallback = (input: HookInput, toolUseID: string | undefined, { signal }) => Promise<HookJSONOutput>`. Events we consume and their payloads (all extend `BaseHookInput { session_id, transcript_path, cwd, agent_id?, agent_type?, permission_mode? }`):

| Hook | Payload fields we use |
|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms?` |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt?` |
| `Notification` | `message`, `title?`, `notification_type` |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type`, (`agent_transcript_path`, `last_assistant_message?` on stop) |
| `Stop` | `last_assistant_message?` |
| `PermissionDenied` | `tool_name`, `tool_use_id`, `reason` |
| `SessionStart` | `source: 'startup'|'resume'|'clear'|'compact'|'fork'` |
| `PreCompact` | `trigger` |

`PermissionRequest` also exists as a hook, but the approve/deny modal is wired to `canUseTool` (it carries the richer prompt metadata and the `suggestions`).

**Messages** (`SDKMessage` union, every member carries `uuid` and `session_id`):

| Message | Key fields | Used for |
|---|---|---|
| `system/init` (`SDKSystemMessage`) | `session_id`, `model`, `tools`, `permissionMode`, `apiKeySource`, `claude_code_version`, `cwd` | session start; **`apiKeySource === 'none'` confirms the subscription login is in use** |
| `assistant` | `message` (Anthropic `BetaMessage`: `content[]` with `text`/`thinking`/`tool_use`), `parent_tool_use_id`, `error?` | transcript; `error` ∈ `authentication_failed | oauth_org_not_allowed | billing_error | rate_limit | overloaded | ...` → 401/429 emotes |
| `stream_event` (`SDKPartialAssistantMessage`, needs `includePartialMessages`) | `event: BetaRawMessageStreamEvent` | live text deltas for speech bubbles / "thinking" |
| `user` | `message`, `parent_tool_use_id`, `tool_use_result?` | tool results in transcript |
| `result` | `subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | ...`, `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `duration_ms`, `is_error`, `permission_denials`, `result` (success) / `errors[]` (error) | turn completion, cost meter, task result |
| `rate_limit_event` | `rate_limit_info { status: 'allowed'|'allowed_warning'|'rejected', rateLimitType: 'five_hour'|'seven_day'|..., utilization?, resetsAt? }` | plan-usage meter and cooldown emote (subscription only) |
| `system/api_retry` | `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (e.g. 429/529), `error` | retry indicator |
| `system/session_state_changed` | `state: 'idle'|'running'|'requires_action'` | agent status |
| `system/permission_denied` | `tool_name`, `tool_use_id`, `message` | feed |
| `system/task_started` / `task_notification` | `task_id`, `description`, `subagent_type`, `status` | intern avatars (with SubagentStart/Stop) |
| `tool_progress` | `tool_use_id`, `tool_name`, `elapsed_time_seconds` | keep long Bash animations alive |
| `system/compact_boundary`, `tool_use_summary`, `auth_status` | — | transcript markers |
| `system/status`, `system/task_summary`, `system/post_turn_summary` (seen in recorded sessions) | — | ignored |

**Cost.** `result.total_cost_usd` is a client-side **estimate** that includes subagents; `result.usage` is main-loop only; `modelUsage[model].costUSD` has the per-model breakdown. In streaming-input mode each turn emits its own `result`; we attribute each `result` to the task that was active for that turn. `Query.accountInfo()` returns `{ email?, organization?, subscriptionType?, apiProvider? }`.

**Sessions.** `persistSession: true` writes transcripts to `~/.claude/projects/...`; we store `session_id` per agent and pass `resume` on restart. `listSessions()` / `getSessionMessages()` exist if we ever want to read the CLI's own transcript, but our replay uses our own event log.

---

## 4. Event model and behaviour mapping

`packages/shared/src/events.ts` defines the single `AgentEvent` discriminated union (zod), e.g.:

```
session_started { sessionId, model, tools[], permissionMode, apiKeySource }
text_delta { text }                      thinking_delta { }
assistant_text { text }                  tool_started { toolUseId, tool, input, summary }
tool_finished { toolUseId, tool, ok, durationMs, summary, diff? }
tool_failed { toolUseId, tool, error }   permission_requested { requestId, toolUseId, tool, input, title, description?, suggestions }
permission_resolved { requestId, decision } subagent_started { subagentId, type } / subagent_stopped { subagentId }
notification { message, kind }           turn_completed { ok, costUsd, usage, numTurns, durationMs, result? , subtype }
error { kind: 'auth'|'rate_limit'|'billing'|'overloaded'|'other', status?, message }
rate_limit { status, windowType, utilization?, resetsAt? }
status { status: 'idle'|'working'|'needs_input'|'paused'|'stopped'|'error' }
interrupted { }                          compaction { trigger }
```

Every event has `{ id, ts, agentId, sessionId?, taskId?, seq }`. `normalizeSdkMessage()` and `normalizeHook()` (server) produce them; both are tested with recorded fixtures.

`mapEventToBehavior(event, ctx): Behavior` (shared, pure, unit-tested) maps to the behaviour set from the brief:

| Event / tool | Behavior |
|---|---|
| `status: idle` | `idle` (client picks wander / sofa / coffee by a seeded roll) |
| `text_delta`/`thinking_delta` with no open tool | `thinking` (head-scratch, "…" bubble) |
| `tool_started` Read/Grep/Glob/LS/NotebookRead | `reading` → bookshelf |
| `tool_started` Edit/Write/MultiEdit/NotebookEdit | `typing` → own desk, monitor flicker |
| `tool_started` Bash/BashOutput/KillShell | `terminal` → server rack, command in bubble |
| `tool_started` WebSearch/WebFetch | `browsing` → library computer |
| `tool_started` Task/Agent (subagent) | `delegating` (gesture) + `subagent_started` spawns an intern |
| `tool_started` AskUserQuestion/ExitPlanMode, `permission_requested`, `status: needs_input` | `raise_hand` (red "!" bubble, sound) |
| `tool_started` other / `mcp__*` | `working` (desk, no code flicker) |
| `tool_failed`, `error` | `sweat` emote (auth/rate-limit variants have distinct bubbles) |
| `turn_completed ok` for a task | `celebrate` (thumbs-up + confetti) |
| `status: paused` | `nap` (zzz) |

`ctx` carries the current behaviour and a seed so the function stays pure and testable.

---

## 5. Authentication

`AuthProvider` interface (server only):

```ts
interface AuthProvider {
  readonly mode: 'API_KEY' | 'CLAUDE_SUBSCRIPTION';
  probe(): Promise<AuthStatus>;                 // never throws, never reads credential files
  childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv; // what the agent subprocess receives
  constraints(): { bindHost: '127.0.0.1' | string; defaultConcurrency: number; notice?: string };
}
```

**First run.** API_KEY is the product default. When the machine has no API key but `claude auth status` reports a claude.ai login, the server preselects subscription mode on first start (and the onboarding wizard shows the choice), so the app is usable immediately; the user can switch at any time in Settings.

**API_KEY mode (default).** Key from `ANTHROPIC_API_KEY` or the OS keychain (`@napi-rs/keyring`, service `deskhaven`, account `anthropic-api-key`). `childEnv` = `{ ...base, ANTHROPIC_API_KEY: key }`. The key is held in one closure, never logged (the logger has a redaction list), never serialised into any DTO, never written to SQLite. Settings UI can *set* a key into the keychain through a POST that returns only `{ stored: true }`; the GET returns only `{ source: 'env' | 'keychain' | 'none' }`.

**CLAUDE_SUBSCRIPTION mode (feature flag `DESKHAVEN_ENABLE_SUBSCRIPTION_MODE`, default on; one constant to disable).** The mode is always selectable while the flag is on; the first-run wizard preselects it when the probe reports a login and no API key is present (agreed 2026-10-02).

- No login UI. The user runs `claude login` in their own terminal (or `/login` inside Claude Code).
- Probe = run the SDK's **bundled** `claude` binary with `auth status`, which prints JSON (`loggedIn`, `authMethod`, `subscriptionType`, `apiProvider`, `email`). Verified on this machine with CLI 2.1.280 (user is logged in via `claude.ai`, plan `max`). We read stdout only; we never open `~/.claude/.credentials.json` or the keychain entry Claude Code uses. Fallback probe: the `apiKeySource`/`accountInfo()` of a real session.
- `childEnv` = `{ ...base }` with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` **deleted** (tested). At runtime the `system/init` message's `apiKeySource` must be `'none'`; if it is anything else we stop the agent and show an error, because an API key leaked into the env and would be billed.
- Server binds `127.0.0.1` only and refuses to start if configured otherwise.
- Persistent HUD notice: "Usage counts against your Claude plan"; default concurrency cap **2** (configurable).
- 401 (`authentication_failed`, `oauth_org_not_allowed`), 402-ish (`billing_error`) and 429 (`rate_limit`, `rate_limit_event.status === 'rejected'`) become `error`/`rate_limit` events → sweat/cooldown emotes + a banner with the reset time.

**Usage meter (HUD).** Auth mode in use (from `apiKeySource`), tokens and estimated cost from `result.usage`/`total_cost_usd` (labelled "API-equivalent estimate" in subscription mode), and the plan windows from `rate_limit_event` (5-hour / 7-day utilisation and reset time) when available.

### 5.1 Policy findings on subscription auth (checked 2026-10-02)

Researched on 2026-10-02 (re-checked the same day before M7: no change) by reading the current pages listed below (plus press coverage for the dated timeline). Re-check these two pages before M2 and before M7 and update this date; the Settings screen will show the date of the last check next to the mode switch.

Primary sources:

- Legal and compliance — https://code.claude.com/docs/en/legal-and-compliance
- Agent SDK overview (authentication note) — https://code.claude.com/docs/en/agent-sdk/overview
- Authentication precedence — https://code.claude.com/docs/en/authentication
- Headless / `--bare` — https://code.claude.com/docs/en/headless
- Env vars — https://code.claude.com/docs/en/env-vars · CLI reference (`claude auth status`) — https://code.claude.com/docs/en/cli-reference
- Support: "Use the Claude Agent SDK with your Claude plan" (updated 2026-06-16) — https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Support: "Use Claude Code with your Pro or Max plan" (updated 2026-08-19) — https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Errors reference (rate-limit messages, retry behaviour) — https://code.claude.com/docs/en/errors

**Findings**

1. **Billing status today.** The support article states the planned per-plan "Agent SDK credit" (announced 2026-05-13, due 2026-06-15) is **paused**: Agent SDK, `claude -p` and third-party app usage "still draw from your subscription's usage limits". API-key usage is unchanged. So subscription usage of the SDK is live and metered against the plan's 5-hour and weekly windows.
2. **What the Legal page prohibits.** Third-party developers may not offer Claude.ai login inside their own applications, may not route requests through Free/Pro/Max credentials *on behalf of their users*, and may not collect, store or intermediate Claude.ai credentials or session tokens. The SDK overview adds: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK", and says developers "should use API key authentication".
3. **What it explicitly allows.** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription." Products that embed Claude Code must not modify the binary, must not remove or restrict any authentication method, must have each end user authenticate with their own key or subscription, and must not resell access. The page also says advertised Pro/Max limits "assume ordinary, individual usage of Claude Code and the Agent SDK".
4. **2026 timeline (volatile).** Jan 9: technical blocks on third-party harnesses spoofing Claude Code. Feb 19: Legal page wording said using subscription OAuth tokens in any other tool "including the Agent SDK, is not permitted". Late Feb: `setup-token` tokens rejected by the raw API. Apr 4: enforcement against third-party clients. May 13: third-party/SDK use on subscriptions reinstated together with the SDK-credit announcement. Jun 15–16: credit paused, usage keeps drawing from plan limits. Today the "not permitted" sentence is gone and replaced by "should use API key authentication". Dates other than the two support articles come from press coverage, not from anthropic.com; the exact revision date of the Legal page could not be verified.
5. **Credential precedence (docs).** Cloud-provider vars → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profiles → subscription OAuth from `/login` (the default for Pro/Max). In non-interactive mode an API key "is always used when present", which confirms the brief's warning that a key in the env silently overrides the subscription. These rules apply to "the surfaces that wrap" the CLI, explicitly including the Agent SDK.
6. **`--bare` gotcha.** `--bare` "never reads OAuth credentials or the system keychain", is "the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release". Verified today that `@anthropic-ai/claude-agent-sdk@0.3.287` does **not** pass `--bare` (it launches `--output-format stream-json --input-format stream-json`), so subscription credentials are read. A future SDK release could flip this and silently break subscription mode; mitigated by pinning the exact version, by the M2 check that `system/init.apiKeySource === 'none'`, and by an upgrade checklist in CLAUDE.md.
7. **Rate limits.** Max plans have a 5-hour session window plus a weekly window across models, shared between claude.ai and Claude Code. Subscription 429s reach the SDK as `rate_limit_event` (`status: 'rejected'`, `rateLimitType`, `resetsAt`), as `system/api_retry` with `error: 'rate_limit'`, and as `assistant.error === 'rate_limit'`. The CLI retries subscription sessions since v2.1.199 (`CLAUDE_CODE_MAX_RETRIES`, default 10).

**Decision for Deskhaven**

- Deskhaven is a local, single-user tool. It offers no login, never touches tokens or credential files, binds to loopback, runs the unmodified bundled binary, and lets the user sign in through Anthropic's own `claude login`. That is the explicitly permitted case ("end user signing in to the unmodified Claude Code binary with their own subscription"), and the support article confirms such usage draws from the plan.
- Because the docs still steer developers to API keys and expect "ordinary, individual usage", the subscription strategy stays **behind the feature flag**, **API_KEY remains the default**, the concurrency cap defaults to **2**, the notice is persistent, and the mode switch shows these findings with the check date.
- Out of bounds regardless of mode: multi-user or hosted deployment, accepting or storing `CLAUDE_CODE_OAUTH_TOKEN`/`setup-token` values (we strip them rather than accept them), any login UI, and any modification of the binary.
- Residual uncertainty: Anthropic "may take measures to enforce these restrictions ... without prior notice". If subscription sessions start failing with `oauth_org_not_allowed` or auth errors, the app shows the error, points to API_KEY mode, and the flag can be flipped off in one place.

---

## 6. Safety and control

- **Permission mode default `'default'`** (ask) for every preset except where stated; `canUseTool` routes to the in-game modal. Decisions: allow once, allow for this session (echo `suggestions` as `updatedPermissions` with `destination: 'session'`), deny with message. Unanswered requests time out (default 10 min, configurable) → deny, and the task moves to *Needs Input*.
- **Dangerous tools.** `Bash` and any write outside the agent's cwd always prompt unless the role preset lists them in `allowedTools`. A `PreToolUse` hook adds defence in depth: `Edit`/`Write`/`NotebookEdit` paths are resolved and must be inside `cwd` (or the role's `additionalDirectories`) else `permissionDecision: 'deny'`.
- **`bypassPermissions` is not reachable from the UI or presets.** `allowDangerouslySkipPermissions` is never set.
- **Sandboxing.** Each agent's `cwd` is its working directory or a dedicated git worktree (`~/.deskhaven/worktrees/<agentId>`, branch `deskhaven/<agent-slug>`). Worktrees are removed only through an explicit UI action that first checks for uncommitted changes.
- **Budgets.** Per agent: `maxTurns`, `maxBudgetUsd` (SDK-enforced, yields `error_max_turns` / `error_max_budget_usd`), and a per-day cost cap enforced by `BudgetGuard` before each prompt is sent (sums today's `turn_completed.costUsd`). Global per-day cap as well.
- **Kill switch.** One button/endpoint: aborts every `AbortController`, calls `interrupt()` first for a graceful stop, sets a `killed` flag that refuses new spawns until cleared, and emits a global event.
- **Concurrency cap.** `AgentManager` counts *busy* agents (in a turn or waiting on a permission); an agent whose prompt would exceed the cap keeps the prompt queued with status `waiting` ("waiting for a desk") and starts as soon as another agent goes idle. Idle processes stay alive so sessions resume instantly; they do not count against the cap (memory is bounded by the idle-timeout in M6).

---

## 7. Data model (SQLite via Drizzle; one DB file at `~/.deskhaven/deskhaven.db`)

| Table | Columns (abridged) |
|---|---|
| `agents` | id, name, avatar (json: palette, outfit), role_preset_id, system_prompt, model, tools (json), allowed_tools (json), permission_mode, workdir, worktree (json: path, branch) , session_id, status, room_id, desk_furniture_id, budget (json: maxTurns, maxBudgetUsd, dailyCapUsd), created_at, updated_at |
| `tasks` | id, title, prompt, status (`backlog|assigned|in_progress|needs_input|review|done`), assignee_agent_id, parent_task_id (manager delegation), result_summary, files_changed (json), cost_usd, position, created_at, started_at, completed_at |
| `events` | seq (pk, autoinc), id (uuid), ts, agent_id, session_id, task_id, type, payload (json) — append-only, indexed by (agent_id, seq) and (ts) |
| `permission_requests` | id, agent_id, task_id, tool, input (json), title, status, decision, created_at, resolved_at |
| `rooms` | id, name, width, height, floor (json), walls (json) — multi-room ready |
| `furniture` | id, room_id, kind, x, y, rotation, meta (json) — interaction points come from the furniture catalog in shared, keyed by `kind` |
| `role_presets` | id, name, json (seeded from `packages/shared/presets/*.json`, editable) |
| `settings` | key, value (json) — auth mode, flags, concurrency, caps, sound |
| `usage_daily` | date, agent_id, cost_usd, input_tokens, output_tokens |

Migrations are hand-written, idempotent `CREATE TABLE IF NOT EXISTS` statements run on open (`apps/server/src/db/client.ts`); Drizzle is used for typed queries only. Documents (agents, tasks, rooms, settings) are stored as validated JSON with a few lifted columns for filtering.

Session transcripts stay where the SDK writes them (`~/.claude/projects/`); we store only `session_id`.

---

## 7.1 Tasks and the board

`TaskService` (server) owns the Kanban state machine. Assigning sends `# Task: <title>\n\n<prompt>` into the agent's session tagged with the task id; every `AgentEvent` carrying that id moves the card: `status working` → In progress, `permission_requested` / AskUserQuestion / ExitPlanMode → Needs input, `turn_completed ok` → Review (result summary = the SDK result or the last assistant text, cost added, files from `git diff --numstat` + untracked), failed turn → Needs input. On boot, queued (`assigned`) tasks are re-dispatched because their prompt never reached a model turn, while mid-turn tasks are flagged for a human nudge (the resumed session already has their context). Drag-and-drop onto an avatar resolves the drop target through the Pixi world (`screenToTile` → `getAvatarAt`).

## 7.2 Manager delegation and interns

A Manager is an ordinary agent whose preset has `manager: true`. Its session gets one extra MCP server, created in-process with `createSdkMcpServer` + `tool()` (`apps/server/src/manager/tools.ts`): `list_agents`, `create_task`, `assign_task`, `task_status`. The tools call `TaskService` directly, so delegated work appears on the board like any other task and is subject to the same budgets and permissions. Delegation is flat by construction: the tools refuse managers as assignees and employees never receive the server. Every agent runs with `strictMcpConfig: true`, so the user's global MCP connectors never load into an agent. Interns are the SDK's own subagents (the `Agent`/`Task` tool): `SubagentStart`/`SubagentStop` hooks become `subagent_started/stopped` events and the world shows a temporary avatar that enters from the door and leaves on stop.

## 7.3 Budgets, cap, idle timeout, kill switch

`BudgetGuard` runs before every dispatched prompt: per-agent `budget.dailyCapUsd` and the global `settings.dailyCapUsd` compare against today's `usage_daily` totals (SDK cost estimates). A refusal turns the task into Needs input with the reason. SDK-side `maxTurns`/`maxBudgetUsd` still apply per session (`maxBudgetUsd` is cumulative for the session, verified: once exceeded every later turn returns `error_max_budget_usd` immediately). The concurrency cap counts busy agents; `idleTimeoutMinutes` stops processes that sat idle (default 15 min) while keeping `session_id`. The kill switch interrupts, ends input streams, aborts after a grace period, and refuses new work until reset.

## 7.4 Replay

The event log is the source of truth, so replay needs no extra recording: the Replay tab loads a time range from `GET /api/events?asc=true&fromTs=…`, puts the store into replay mode (live `event` messages are held back), clears the timeline (feed, transcripts, behaviours) and feeds the logged events through the very same `applyEvent` → `mapEventToBehavior` path at `(ts[i+1] − ts[i]) / speed` (capped at 2.5 s per gap). Scrubbing rebuilds state from the range start without animations; stopping clears the timeline and asks the server for a fresh snapshot (`hello`), which also replays the recent persisted events into the feed.

## 8. Front-end structure

- `src/game/` — Pixi scene: `iso.ts` (tile ↔ screen maths, 64×32), `pathfinding.ts` (A\*), `Avatar.ts`, `Furniture.ts`, `Room.ts`, `WorldController.ts` (subscribes to the store, applies behaviours, tweens with the Pixi ticker, depth-sorts by `x+y` then `y`), `bubbles.ts`, `emotes.ts`, `sound.ts` (WebAudio), `assets/manifest.ts` (+ placeholder renderer).
- `src/state/` — Zustand slices: `agents`, `tasks`, `events` (ring buffer + per-agent transcripts), `rooms`, `settings`, `ui`.
- `src/net/ws.ts` — WS client with reconnect and zod validation of `ServerMessage`.
- `src/ui/` — HR desk, Task board (dnd-kit; the canvas is one droppable and the drop target avatar is resolved from pointer → tile), Inspector, Feed, Permission modal, Settings, HUD, Room editor (M5), Replay controls (M7).

Rendering runs on the Pixi ticker, not React state; React re-renders only panels. Avatar sprites: 4-direction (N/E/S/W) first; 8 later if art allows.

---

## 9. Risk list

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | **Policy on Agent SDK + Pro/Max subscriptions changes again** | medium / high | Strategy behind one feature flag; findings dated in §5.1; probe-only detection; no token handling at all; API_KEY stays default |
| 2 | **SDK surface churn** (0.3.x, many `@alpha` fields, new message subtypes) | high / medium | Pin exact version; single adapter file; fixture-based normaliser tests; unknown message types map to `unknown` events instead of throwing |
| 3 | **`env` replaces, not merges** → missing `PATH`/`HOME` breaks the subprocess, or a key leaks | medium / high | `childEnv` always spreads the base env; tests assert presence of PATH/HOME and absence of the three auth vars in subscription mode; runtime check on `apiKeySource` |
| 4 | **Resource use**: one 200+ MB CLI subprocess per agent; docs suggest ~1 GiB RAM baseline per session | medium / medium | Concurrency cap (2 in subscription mode, 4 in API mode by default); idle agents keep the process but no turn runs; "stop" frees the process while keeping `session_id` for resume |
| 5 | **Rate limits on a Max plan with 2–3 concurrent agents** | high / medium | Cap, `rate_limit_event` meter, cooldown emote and queueing instead of retry storms; `api_retry` surfaced |
| 6 | **Permission deadlocks** (agent waits forever on `canUseTool`) | medium / medium | Timeout → deny + *Needs Input*; raise-hand + sound; requests persisted so a page reload still shows them |
| 7 | **Diffs for Edit/Write** need pre-tool file snapshots | medium / low | `PreToolUse` snapshot for `Write` (size-capped), `Edit` diffs from `old_string`/`new_string`; `git diff --stat` at task end when cwd is a git repo |
| 8 | **Native modules** (`better-sqlite3`, `@napi-rs/keyring`) and the 228 MB CLI download | low / medium | Both ship prebuilds for Node 22 darwin-arm64; `pnpm i` documented as needing network once; Node ≥ 22 enforced via `engines` |
| 9 | **Local toolchain**: corepack's pnpm shim here points at a missing pnpm 12.6.0 | certain / low | M0 fixes it (`corepack prepare pnpm@10.34.5 --activate`, `packageManager` pinned in root `package.json`); recorded in CLAUDE.md |
| 10 | **Worktree lifecycle** (uncommitted work, stale branches) | medium / medium | Explicit create/remove UI, dirty check before removal, never auto-delete |
| 11 | **Session resume after SDK upgrade** fails or replays stale context | low / medium | On resume error fall back to a fresh session seeded with the last task summary; show it in the feed |
| 12 | **Streaming-input semantics** (one `result` per turn, queued prompts, interrupt racing) | medium / medium | Runtime state machine with tests; one in-flight prompt per agent; `interrupt()` then await the `result` before sending the next |
| 13 | **Scope** — 7 milestones of real product | high / high | Vertical slices, placeholder art, subagents with file ownership, "never move on with a broken build" |
| 14 | **TypeScript 7 / Vite 8 / Vitest 5 / Zod 4 are all very recent** | medium / low | Pin TS 5.9; pin exact majors; keep configs minimal |

---

## 10. Things deliberately not done

- No Electron/Tauri shell (browser + local server is enough and avoids a second credential story).
- No `@pixi/react`, no Redux, no tRPC, no GraphQL, no ORM beyond Drizzle's query builder.
- No cloud, telemetry, or remote dependencies at runtime.
- No reading, copying, or proxying of Claude Code OAuth tokens — ever.

---

## 11. Graphics overhaul: 3D renderer behind the `World` contract (planned 2026-10-03)

### 11.1 Decision and shape

Real-time 3D with **Three.js** (`three@0.186.1`, `@types/three@0.186.0`, WebGL 2 `WebGLRenderer`;
not WebGPU, not Babylon): glTF + skeletal animation + instancing + PCF soft shadows are built in and
well typed. Pre-rendering 3D to HD sprite sheets (the reserved `sheet` manifest kind) was rejected
for v1: it needs an offline Blender pipeline per outfit combination and bakes lighting, so neither
the editor's style changes nor the `Avatar` DTO customisation would reach the art. It remains the
fallback if the frame budget fails.

The renderer is selected at build time with `VITE_RENDERER=pixi|three` and overridden at runtime by
`localStorage['deskhaven.renderer']` (Settings toggle, G3). `createWorld()` returns a `LazyWorld`
that queues every call until the chosen backend module is dynamically imported in `mount()`, so the
Pixi bundle never contains Three and vice versa. `three` has been the default since the G3 parity
commit; `VITE_RENDERER=pixi` or the selector restores the pixel-art path.

**One simulation, two scene backends** (G1): `world.ts` is split into a renderer-agnostic
`WorldCore` (tiles, A\*, motions, stations, behaviour → pose, editor pointer state machine, pre-mount
queue, events, camera over a `CameraView`) that drives a small `Scene` port; `PixiScene` wraps the
existing `avatar.ts`/`room.ts`/`bubble.ts`; `ThreeScene` is new. Pointer and keyboard input move from
Pixi's federated events to DOM listeners in the core (`window` pointerup classified by canvas-rect
containment reproduces `pointerupoutside`), and a backend `pick(sx, sy)` called once at pointerdown
replaces `e.target instanceof AvatarSprite`. Parity of editor, board drag-and-drop, replay and bubble
timings therefore comes by construction, and the core is testable in Node with a `FakeScene`.

```
apps/web/src/game/
  types.ts             World contract (unchanged)
  renderer.ts          rendererKind(), createWorld() → LazyWorld
  lazy-world.ts        queue-until-mount proxy, StrictMode-safe
  pose.ts              Pose union + poseFor (pure)
  camera.ts            zoom/pan/fit over CameraView (pure except attach)
  scene.ts             Scene port (G1)        core/world-core.ts  simulation (G1)
  pixi/*               PixiScene (G1)         three/*             ThreeScene
  three/camera.ts      iso ortho camera       three/textures.ts   floor/wall canvas textures
  three/room.ts        floor/walls/grid       three/furniture.ts  glTF cache + procedural fallback
  three/character.ts   rig, outfit, props     three/anim.ts       pure pose → clip/overlay machine
  three/emotes.ts      sweat/zzz/!/hourglass/confetti             three/overlay.ts DOM labels + bubbles
```

### 11.2 Coordinate system

Tile `(x, y)` → world `(x, 0, y)`, 1 unit = 1 tile, up = +Y. A 64×32 diamond is an orthographic
view at yaw 45° and elevation 30° (`sin 30° = 0.5` gives the 2:1 ratio). With `64/√2 ≈ 45.255` px
per unit at zoom 1 the camera projects tile `(x, y)` to exactly `tileToScreen(x, y)` from `iso.ts`;
heights project at `cos 30° × 45.255 ≈ 39.2` px per unit (the 96 px placeholder wall ≈ 2.5 units). A
unit test projects tile centres through the real `OrthographicCamera` and asserts equality with
`tileToScreen` within 0.01 px, so `screenToTile`, `roomBounds` and the camera fit maths are reused
unchanged; only avatar/furniture picking needs a raycast. The camera never rotates: 8 facings keep
their meaning and `screenToTile` stays exact.

### 11.3 Lighting and materials

`HemisphereLight` + one shadow-casting `DirectionalLight` (2048² map, orthographic shadow camera
fitted to the room, `PCFSoftShadowMap`), ACES tone mapping, sRGB output, pixel ratio ≤ 2,
`antialias: true`. `MeshStandardMaterial` everywhere; floor and wall style ids map 1:1 to today's
styles with textures painted once per style on a canvas. No SSAO; bloom only for monitor glow if
the G3 measurements leave budget.

### 11.4 Characters (G2)

Base body: KayKit Adventurers `Rogue.glb` (CC0, see ASSETS.md): 41-joint rig, separate skinned
meshes per body part, `handslot.l/.r` bones for props, 76 embedded clips. Each avatar is a
`SkeletonUtils.clone` with its own `AnimationMixer` (0.2 s cross-fades). Outfit: the `Avatar` DTO's
skin/hair/shirt/pants colours become flat materials on the body-part meshes (the pack's gradient
atlas is not used); hair styles and accessories are procedural meshes attached to the `head` and `chest`
bones (the rig has no neck bone); interns are scaled 0.8 and desaturated. Facing: 8 yaws from the motion deltas with shortest-arc turn smoothing; the station targets keep
the 4-way `Facing`. Walking plays `Walking_A` up to 1.6× and switches to `Running_A` (0.8 s cycle,
1.2-unit stride) above that, so feet stay planted at the 2.5 tiles/s walk speed. Poses: a pure state machine (`three/anim.ts`) maps the
existing `Pose` union to a base clip plus overlays and props, e.g. `typing` = `Sit_Chair_Idle` + arm
oscillation at the desk's own keyboard + monitor glow; `reading` = idle/sit + book prop + head tilt; `raise_hand`
= idle + additive arm raise (or `Spellcast_Raise`); `thinking` = idle + head-scratch overlay; `nap` =
`Lie_Idle` or seated head droop + zzz; `celebrate` = `Cheer` + confetti; `sweat`/`cooldown` = idle +
emote. No CC0 pack ships office clips, so this hybrid is the approved deliverable.

### 11.5 Furniture, picking, editor, DnD

Furniture is glTF per kind (Kenney Furniture Kit converted OBJ → GLB, flat colour materials) with a
procedural low-poly fallback per kind (server rack, whiteboard, and any model that fails to load);
pieces are cloned, not instanced (< 40 per room keeps draw calls < 150); instancing is used for
floor tiles, wall segments and the grid. `pick()` raycasts avatar hit volumes first, then furniture,
then the ground plane → tile; `getAvatarAt` stays tile-based in the core, so the board's
`screenToTile → getAvatarAt` chain is unchanged. Editor: grid as line segments, hover tile as a
translucent quad, ghost as a tinted translucent clone (green/red by `valid`), highlight as an
emissive pulse, drag preview moves the clone. Bubbles and name labels are a DOM overlay positioned
from the projected head anchor each frame (same texts, truncation rules and durations as the Pixi
path, shared through `bubble-text.ts`; overlay text keeps a fixed CSS size instead of scaling with
the zoom); emotes are in-scene sprites and instanced particles so they are occluded correctly.

### 11.5a Polish (G4)

Camera `fit`/`zoomAt` ease over 180 ms (cubic ease-out, targets accumulate under the wheel, drag pans
stay immediate, the mount fit snaps). Idle avatars play a seeded flourish every 6–14 s (look-around,
stretch, weight shift) as an extra overlay layer, only on `Idle`/`Sit_Chair_Idle` with no prop. The
door leaf swings open while an avatar is within one tile of the door and closes 0.6 s after. Hair,
accessory and mug meshes are merged per material so a character costs ≤ 8 draw calls in the main
pass. The HR desk shows offscreen 3D renders of the avatar (`game/preview.ts` → `three/preview.ts`:
one shared alpha renderer, the cached rig re-dressed per call, a 64-entry LRU) and falls back to the
pixel sprite when WebGL or the model is unavailable. The committed character file is the stripped
GLB (six clips, six body meshes, quantised; `scripts/strip-character.mjs`).

### 11.6 Performance budget and out of scope

≤ 150 draw calls in the main pass (the `renderer.info` number includes the shadow pass, so the
stats overlay shows roughly double), one shadow map, ≤ 2× pixel ratio, continuous
`requestAnimationFrame` with the 100 ms dt clamp, the loop paused only while the canvas is detached
(never on `document.hidden`, see CLAUDE.md), `?stats=1` overlay (fps, draw calls, triangles,
avatars) and a one-way auto-degrade (shadow map 1024², pixel ratio 1.5) when the rolling fps
stays below 45 for 3 s. Acceptance: ≥ 60 fps for 10 s with 6 agents + 2 interns on the MacBook Air; degrade
switches (1024² shadow map, pixel ratio 1) are one constant each. Out of scope: rotating camera,
multiple rooms in the UI, WebGPU, SSAO, Mixamo or any non-CC0 source.

### 11.7 Risks (phase 2)

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| 1 | Base body's material layout or bone names unusable | resolved in G0 | Inspected: per-part skinned meshes, named bones, `handslot` props; flat materials replace the atlas |
| 2 | Animation gaps (no typing/reading/nap clips) look stiff | high / medium | Hybrid clips + procedural overlays + props, iterated against replay |
| 3 | Refactoring `world.ts` regresses the Pixi path | medium / high | `FakeScene` core tests, replay + screenshots before/after, parity checklist, Pixi stays default until G3 |
| 4 | Frame rate on the Air with shadows + 8 skinned meshes | medium / high | §11.6 budget, stats overlay, degrade switches, sprite-sheet fallback documented |
| 5 | Bundle and repo growth (Three ≈ 170 KB gzip, 3.6 MB character GLB) | certain / low | Dynamic import per renderer; unused clips/meshes stripped in G2; sizes recorded in STATUS |
| 6 | Missing model served as `index.html` by the SPA fallback | fixed in G0 | Server returns 404 for file-like paths; loader falls back to the procedural mesh |
| 7 | DOM overlay drifts from the canvas on resize/zoom | medium / low | Positions recomputed every frame from the camera |
| 8 | StrictMode double mount leaks WebGL contexts | medium / medium | `destroy()` disposes everything and forces context loss; `mountGen` guard reused |
| 9 | Hot reload of the Three world leaves a stale context | certain / low | Reload the page (same rule as today) |
| 10 | Licence mistakes | low / high | CC0 only, licence texts committed, one ASSETS.md row per file |
