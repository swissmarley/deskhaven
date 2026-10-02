# AgentHotel — Original brief (verbatim, received 2026-10-02)

# ROLE
You are a senior full-stack and game engineer. Build "AgentHotel": a Habbo-Hotel-inspired
isometric pixel-art office where every character is a REAL Claude Code agent. I can spawn
agents, assign tasks, manage them, and watch them work live. It must be a complete,
usable app, not a demo.

# HOW TO WORK (follow strictly)
1. Start in PLAN MODE. Read this whole brief, then produce ARCHITECTURE.md (decisions and
   rationale), a milestone plan, and a risk list. Ask at most 5 blocking questions;
   otherwise decide sensibly and record the decision. Then wait for my "go".
2. Build in vertical slices. After each milestone: run it, test it, commit, and write a
   3-line status note. Never move on with a broken build.
3. Use subagents for parallelizable work (assets, server, UI) with clear file ownership.
   Keep CLAUDE.md updated with commands, conventions, and gotchas.
4. Verify, don't assume. Before coding against the Claude Agent SDK, read its current docs
   for exact API names, hook events, permission callbacks, and message shapes. Write tests
   for the event-mapping layer.
5. Prefer simple, boring tech. Strict TypeScript everywhere. No premature abstraction.

# PRODUCT VISION
A browser-based isometric hotel office (tile grid, click-to-walk, avatars, furniture,
speech bubbles, side log panel). Each agent is an avatar. When an agent actually reads
files, edits code, runs commands, searches the web, or waits for permission, its avatar
visibly does the matching thing in the room. The app must also show WHAT agents produce
(diffs, summaries, results), not just that they are busy.

# TECH STACK (defaults; justify any change in ARCHITECTURE.md)
- Monorepo (pnpm workspaces): /apps/web, /apps/server, /packages/shared (types + schemas)
- Frontend: React + Vite + TypeScript; PixiJS for the isometric canvas; React for UI
  panels; Zustand for state.
- Backend: Node + TypeScript (Fastify), WebSocket for live events, SQLite
  (better-sqlite3 + Drizzle) for persistence. Validate all events with zod.
- Agent engine: @anthropic-ai/claude-agent-sdk (TypeScript). Each hotel "employee" is one
  SDK session (query() async iterator) in its own working directory or git worktree.
- Local-first: `pnpm i && pnpm dev` runs everything. No cloud dependencies.

# AUTHENTICATION (two switchable modes, compliance-first)
Implement an `AuthProvider` interface with two strategies, selectable in Settings.

1. API_KEY mode (default, always supported)
   - Key from env ANTHROPIC_API_KEY or the OS keychain (keytar).
   - Never log it, never send it to the browser, never store it in SQLite or the repo.
   - Pass it only through the agent child-process environment.

2. CLAUDE_SUBSCRIPTION mode (Pro/Max login, local use)
   - The user signs in through Anthropic's own official flow (`claude login` in their
     terminal). The app MUST NOT build its own login UI, and MUST NOT read, copy, parse,
     log, or store OAuth tokens or credential files, or proxy requests for other users.
   - Detect availability only through a harmless probe (a trivial SDK query or the CLI
     status command) and show "logged in / not logged in".
   - Spawn agents with ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, and
     CLAUDE_CODE_OAUTH_TOKEN removed from the child env, so the subscription is used and
     no accidental API billing occurs. (An API key in the env silently overrides the
     subscription.)
   - Bind the server to 127.0.0.1 only in this mode; refuse to start otherwise.
   - Show a persistent notice that usage counts against the user's plan, with a default
     concurrency cap of 2 agents (configurable) to avoid rate-limit exhaustion.
   - Surface 401 and 429 errors as in-game emotes plus a clear message.

Policy volatility: Anthropic's rules and billing for Agent SDK use on subscriptions have
changed several times in 2026 (separate SDK credits were announced, then paused). Before
implementing, check the current Agent SDK auth docs, the Legal and Compliance page, and
Anthropic's latest billing announcements. Record findings and the date in ARCHITECTURE.md.
Keep the subscription strategy behind a feature flag so it can be disabled in one place.
Add a usage meter (tokens, estimated cost, and the auth mode in use) in the HUD.

# CORE FEATURES

## 1. Agent management ("HR desk")
- Create an agent: name, avatar (palette and outfit picker), role preset, system prompt,
  model, allowed tools, permission mode, working directory or repo.
- Role presets (editable JSON): Architect (read-only, plans), Engineer (edit and bash),
  Reviewer (read-only), Researcher (web and read), QA (bash and tests).
- Lifecycle: spawn, pause, resume, stop, delete. Persist session_id so an agent can resume
  with prior context.
- Per agent show: status, current task, token usage, cost, tool-call history.

## 2. Task system ("Task board")
- Kanban columns: Backlog, Assigned, In Progress, Needs Input, Review, Done.
- Create a task and assign it by drag-and-drop onto an avatar or via dropdown. Assigning
  sends it as the prompt to that agent's session and streams results back.
- Optional "Manager" agent that decomposes a goal into tasks and delegates to employees.
  Keep delegation flat (one level); the SDK limits nested subagents.
- Each task stores: prompt, assignee, status, result summary, files changed, cost,
  timestamps.

## 3. Live visualization (the game)
Normalize SDK messages and hooks (PreToolUse, PostToolUse, SubagentStart/Stop,
Notification, permission requests, Stop) into ONE typed AgentEvent schema. Map events to
behaviors with a single pure, unit-tested function
`mapEventToBehavior(event) -> Behavior` in /packages/shared:
- Idle: wander, sit on the sofa, chat at the coffee machine
- Thinking (streaming text, no tool): head-scratch animation and a "..." bubble
- Read / Grep / Glob: walk to the bookshelf, reading animation
- Edit / Write: sit at the desk, typing animation, code flicker on the monitor
- Bash: walk to the server rack or terminal station, show the command in a bubble
- WebSearch / WebFetch: walk to the library computer
- Permission requested or needs input: raise hand, red "!" bubble, sound; clicking opens
  an approve/deny modal wired to the SDK permission callback
- Subagent start/stop: a temporary "intern" avatar walks in and out
- Error: sweat-drop emote; task done: thumbs-up and confetti
Avatars use A* pathfinding on the tile grid, 4 or 8 direction sprites, depth-sorted
isometric rendering, and smooth tweening. Speech bubbles show truncated live text.

## 4. Room and world
- Tile-based room editor: place, move, and rotate furniture (desks, chairs, plants,
  bookshelf, server rack, coffee machine, whiteboard); paint floors and walls. Save
  layouts to SQLite.
- Furniture exposes interaction points (seat, stand-at) used by the behavior system.
- Multiple rooms is a stretch goal; design the data model to allow it.

## 5. Inspector and feed
- Clicking an avatar opens a side panel: live transcript, tool calls, diffs of edited
  files, task, cost. Actions: send message, interrupt, pause, reassign desk.
- Global activity feed in the style of a Habbo chat log, with sound toggles.
- Replay mode: all events are logged to SQLite and can be replayed in the viewer.

# ASSETS
- No copyrighted Habbo assets, names, or logos. Create an original look using procedurally
  generated sprite sheets or CC0 packs, with licenses recorded in ASSETS.md.
- Isometric tile 64x32. Use a single asset manifest so art can be swapped without code
  changes.
- Build a placeholder-art path first (colored isometric boxes and labeled avatars) so the
  game loop works before art is polished.

# SAFETY AND CONTROL
- Default permission mode: ask. Dangerous tools (Bash, writes outside the workdir) need
  approval through the in-game modal unless the role preset explicitly allows them.
- Each agent is sandboxed to its working directory; use git worktrees for parallel
  engineers on one repo.
- Global kill switch, per-agent and per-day budget caps (max turns, max cost), and visible
  cost meters.

# MILESTONES
M0  Plan, scaffold monorepo, lint/typecheck/test scripts, CLAUDE.md, policy check noted
    in ARCHITECTURE.md
M1  Isometric room renders; one avatar walks on click; placeholder art
M2  AuthProvider with both modes; server spawns ONE real SDK agent; events stream over
    WebSocket; avatar reacts (read/edit/bash/idle) through tested mapEventToBehavior
M3  Multi-agent spawn, HR desk UI, persistence, session resume
M4  Task board, assignment, results, permission modal
M5  Room editor, furniture interaction points, saved layouts
M6  Manager delegation, subagent interns, budgets, kill switch, concurrency cap
M7  Polish: sounds, emotes, replay, onboarding, README with GIF

# DEFINITION OF DONE
- `pnpm i && pnpm dev` starts server and web. In either auth mode, I can create 3 agents,
  give each a task in a sample repo, watch them walk and work in real time, approve a
  permission request, and see results on the board.
- Typecheck, lint, and tests pass. README documents setup, both auth modes and their
  caveats, architecture, and how to add roles, furniture, and behaviors.
