# Deskhaven guide: setup and usage

Deskhaven is an isometric 3D office where every character is a real Claude Code agent. You hire agents,
give them tasks from a Kanban board, and watch them read, edit, run commands and ask for permission in
the room. This guide takes you from a fresh clone to your first finished task, then covers every part of
the UI, the configuration, and what to do when something goes wrong.

Contents: [Requirements](#1-requirements) · [Install and start](#2-install-and-start) ·
[Choose how agents authenticate](#3-choose-how-agents-authenticate) ·
[Your first task](#4-your-first-task-five-minutes) · [Using the app](#5-using-the-app) ·
[Using it on your own repository](#6-using-it-on-your-own-repository) ·
[Settings and limits](#7-settings-and-limits) · [Configuration reference](#8-configuration-reference) ·
[Running a built copy](#9-running-a-built-copy) · [Troubleshooting](#10-troubleshooting) ·
[Safety and cost](#11-safety-and-cost) · [Developing](#12-developing)

---

## 1. Requirements

| Need | Details |
|---|---|
| Node.js | 22 or newer (`node --version`). Node 20 is not supported: `pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE` (see "ERR_PNPM_UNSUPPORTED_ENGINE" in section 10). The repository root has a `.nvmrc` of `22`, so `nvm use` or `fnm use` selects it. |
| pnpm | 10.x. The repo pins `pnpm@10.34.5`; the easiest way is `corepack enable` (ships with Node). If that fails with `EACCES` (Node installed system-wide), use the user-local install below. |
| Git | Needed for the git worktree option and for the sample repository. |
| A browser with WebGL 2 | Any current Chrome, Edge, Firefox or Safari. Without WebGL the app falls back to the pixel-art renderer. |
| Network (first install) | `pnpm install` downloads about 230 MB: the Agent SDK ships its own native `claude` binary. The agents also need the Anthropic API at runtime. |
| One way to pay for agents | Either an Anthropic API key, **or** a Claude Pro/Max plan logged in with the `claude` CLI (see section 3). |
| No C/C++ toolchain | `better-sqlite3` ships prebuilt binaries for Linux (glibc and musl), macOS and Windows on x64 and arm64, and `pnpm install` uses them without compiling, so `make` and `g++` are not needed. Only on other platforms see "Could not locate the bindings file" in section 10. |

Everything runs on your machine. The server listens on `127.0.0.1` only and only answers the Deskhaven web
app (see section 11 for how other websites are kept out). Nothing is sent anywhere except the Anthropic API
calls your agents make.

**pnpm without root.** `corepack enable` writes shims next to the `node` binary; with a system-wide Node
(e.g. `/usr/local/bin`) it fails with `EACCES`. The most reliable fix is a user-local pnpm from npm:

```bash
npm install -g --prefix ~/.local pnpm@10.34.5   # installs ~/.local/bin/pnpm, no root needed
export PATH="$HOME/.local/bin:$PATH"            # add this line to ~/.bashrc or ~/.zshrc
pnpm --version                                  # 10.34.5
```

If you prefer corepack, point both its shims **and its cache** at folders you own. `--install-directory`
alone is not enough when `COREPACK_HOME` (where corepack downloads pnpm) is root-owned, for example set by
a system-wide profile:

```bash
mkdir -p ~/.local/bin ~/.cache/corepack
export COREPACK_HOME="$HOME/.cache/corepack"    # add both exports to ~/.bashrc or ~/.zshrc
export PATH="$HOME/.local/bin:$PATH"
corepack enable --install-directory ~/.local/bin pnpm
pnpm --version                                  # 10.34.5 (downloaded into $COREPACK_HOME)
```

## 2. Install and start

```bash
git clone <your repository URL> deskhaven
cd deskhaven
corepack enable            # once, if `pnpm --version` is not 10.x; EACCES? use the user-local pnpm (section 1)
pnpm install               # downloads the native claude binary (better-sqlite3 uses a prebuilt one)
pnpm dev                   # server on 127.0.0.1:8787, web UI on 127.0.0.1:5173
```

Open **http://127.0.0.1:5173**. The first start creates the data directory `~/.deskhaven/` (SQLite
database, git worktrees, the sample repository).

On the first visit a three-step wizard appears:

1. **Authentication mode.** It shows a live probe. If you have no API key but are logged in with
   `claude login`, subscription mode is preselected.
2. **Sample workspace.** Copies a tiny TypeScript CLI to `~/.deskhaven/sample-repo` and makes it a git
   repository. It contains a failing test and a planted bug so agents have real work.
3. **First hire.** Creates your first agent.

You can skip the wizard and do everything later from the side panel.

## 3. Choose how agents authenticate

Open **Settings → Authentication**.

### Option A: API key

1. Create a key in the Anthropic Console.
2. Either export it before starting the server (`export ANTHROPIC_API_KEY=sk-ant-...` then `pnpm dev`) or
   paste it into Settings. A pasted key goes to your operating system keychain; it is never written to
   disk by the app, never sent to the browser and never logged. Agents that are already running pick up
   a new key with their next task (their idle process restarts and resumes the same session).
3. Select **API key**. Agents are billed per token on your API account. Without a key, agents refuse to
   start instead of falling back to other credentials, and a session that reports anything but the API
   key as its credential source is stopped.

**Bedrock, Vertex, Foundry or an `apiKeyHelper`.** These count as configured credentials in API key mode,
so no `ANTHROPIC_API_KEY` is needed:

- `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1` or `CLAUDE_CODE_USE_FOUNDRY=1` in the server's
  environment (plus that provider's usual credentials and region variables): any credential source the
  session reports is accepted.
- An `apiKeyHelper` in the working directory's `.claude/settings.json` (the project settings agents load):
  sessions reporting `apiKeyHelper` or `ANTHROPIC_API_KEY` are accepted.
- Anything else (for example a helper configured elsewhere): set `DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS=1`.
  Agents then start without a key and run on whatever Claude Code finds, **including your claude.ai
  login**, so only use it when you know which credentials that will be.

### Option B: Claude Pro/Max subscription (your own machine only)

1. In your own terminal run `claude login` and finish Anthropic's login flow. Deskhaven never shows a
   login screen and never reads or stores your credentials.
2. In Settings pick **Claude subscription**. The status line should read "Logged in".
3. Agents use your plan's usage limits (five-hour and weekly windows) instead of per-token billing. The
   app removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` from the agent
   processes so a stray key cannot override the plan, and caps concurrent agents at 2 by default.

Notes that apply to both:

- The cost figure in the top bar is an **estimate** (the SDK's API-equivalent price). In subscription mode
  nothing is billed per token; use the number to compare agents and to set caps.
- Anthropic's rules for using the Agent SDK with subscriptions have changed before. The findings and the
  date they were checked are in [ARCHITECTURE.md §5.1](../ARCHITECTURE.md). Set
  `DESKHAVEN_ENABLE_SUBSCRIPTION_MODE=0` to disable that mode completely.

## 4. Your first task (five minutes)

1. **Hire an agent.** Side panel → **HR desk**. Give it a name, pick an avatar (skin, hair style and
   colour, shirt, pants, accessory), choose the role **Engineer**, then click **Use the sample repo** to
   fill in the working directory. Click **Hire**. The character walks in and sits at a desk.
2. **Create a task.** Click **New task** under the room. Title: `Fix the failing test`. Prompt: `Run the
   tests in this repo, find why mean() fails, fix it, and show me the result.`
3. **Assign it.** Drag the card from **Backlog** onto your character in the room (or use the assignee
   dropdown in the card's detail view). The card moves to **Assigned**, then **In progress**.
4. **Watch.** Reading files sends the character to the bookshelf, editing keeps them at the desk with the
   screen glowing, running a command walks them to the server rack, and thinking shows a bubble.
5. **Approve.** The Engineer preset asks before running shell commands. When the character raises a hand
   and a red "needs permission" bubble appears, a dialog opens: **Allow once**, **Allow for this session**
   or **Deny** (with an optional reason sent back to the agent).
6. **Review.** The task lands in **Review** with a summary, the files changed (with diffs in the
   Inspector), the cost and timestamps. Drag it to **Done**.

## 5. Using the app

### Layout

- **The room** (left): zoom with the mouse wheel, pan with middle-drag or Space + drag. Click a floor tile
  to walk the selected character there. Click a character to select it and open the Inspector.
- **Top bar**: connection state, authentication mode and the plan-usage notice, estimated cost as
  **today / all time** (the daily cap is enforced separately, see section 7), today's token count, desks in use, the plan windows when the SDK reports them, the **Board** toggle,
  the sound toggle and the **Kill switch**.
- **Side panel** tabs: **HR desk**, **Inspector**, **Feed**, **Room**, **Replay**, **Settings**.
- **Task board** (bottom): Backlog → Assigned → In progress → Needs input → Review → Done.

### HR desk (agents)

Create and edit agents: name, avatar, role preset, model, permission mode, working directory (an absolute
path to an existing folder; `/`, top-level system folders and your home folder itself are refused), or a
dedicated git worktree of it, system prompt addition, tool lists and budgets. Open **Advanced** for the system
prompt, allowed and denied tools, per-agent daily cap, max turns and the desk assignment.

Lifecycle buttons live in the Inspector: **Start**, **Pause**, **Resume**, **Stop** and **Fire**. A
stopped agent keeps its session id, so starting it again resumes the earlier conversation, even after you
restart the server.

Roles (editable JSON under Settings → Role presets):

| Role | What it is for |
|---|---|
| Architect | Read-only. Reads the code and writes plans. |
| Engineer | Edits auto-approved inside the working directory; shell commands ask first. |
| Reviewer | Read-only review of changes. |
| Researcher | Web search plus reading. |
| QA | Test commands pre-approved. |
| Manager | Delegates: lists agents, creates tasks and assigns them through the board. One level only. |

**Models:** Settings → Models sets the defaults for new hires. Per-agent overrides are stored on the agent.
Custom role presets with `manager: true` follow the Manager default from Settings when you leave Model on
Default; any `model` field in the preset JSON is ignored (same as the built-in Manager).

### Task board

- **New task** takes a title and a prompt. Drag a card onto a character, or onto another column to change
  its status.
- Cards move on their own: working → **In progress**, permission or question → **Needs input**, turn
  finished → **Review** (with the result summary and `git diff` file list). A failed turn goes to **Needs
  input**.
- Open a card for the full prompt, the result, the changed files, the cost, and the actions: reassign,
  nudge or reply, delete.

### Permissions

The default permission mode is **ask**. Dangerous tools (shell commands, writes outside the working
directory) open the approval dialog. A guard denies edits outside the agent's working directory in every
mode. Unanswered requests expire into a denial after the timeout in Settings (default 10 minutes), and the
task shows **Needs input** with the reason.

### Manager agent

Hire a Manager, give it a goal as a task, and it creates and assigns tasks to your other agents through
in-process tools. Delegated tasks show up on the board like any other and obey the same budgets and
permissions. Managers never delegate to managers.

### Interns

When an agent uses the SDK's `Agent` tool (a subagent), a smaller intern character walks in through the
door, stands next to the parent, and leaves when the subagent finishes.

### Inspector and Feed

- **Inspector**: live transcript, tool calls with results, diffs of edited files, current task, tokens and
  cost. The message box at the bottom sends a message to the agent.
- **Feed**: a chat-log style stream of everything that happens across all agents.

### Room editor

Side panel → **Room**.

- Pick a furniture kind and click a tile to place it; click furniture to select it, drag to move.
- `R` rotates, `Delete` or `Backspace` removes, `Esc` returns to select mode.
- Paint floor styles and wall styles (click the top row of tiles for the north wall, the left column for the
  west wall).
- The ghost turns red when a placement would block another piece's access tile or leave no room for a
  character to reach a station. Invalid moves are refused with a reason.
- Layouts are saved to SQLite automatically. **Export JSON** and **Import JSON** share layouts;
  **Reset to default** restores the original room.
- Behaviours use the live layout: move the bookshelf and the next file read walks to its new position.

### Replay

Every event is logged, so you can watch the office re-enact past work at no cost. **Replay** → pick a range
(last 5 minutes, 15 minutes, hour, everything; only events in that range are replayed) → **Start replay**. Speeds from 1× to 64×, step, pause,
scrub, **Stop** returns to live state. Live events are held back while a replay runs.

### Renderers and performance

The 3D renderer (Three.js) is the default. **Settings → Renderer** switches to the original pixel-art
renderer; the choice is stored in the browser and applies after a reload. Add `?stats=1` to the URL for an
fps, draw-call and triangle overlay. If the frame rate stays under 45 fps for a few seconds the 3D renderer
lowers its shadow resolution and pixel ratio once.

### Sounds

Short synthesised sounds play for tool use, permission requests, completions and errors. Toggle them with
the speaker button in the top bar; per-sound switches and the volume are in Settings.

### Emotes you will see

Raised hand and red "!" mean the agent needs you. A falling sweat drop means a tool failed or an error
occurred. A ticking hourglass with a blue tint means a rate limit cooldown. Thumbs-up and confetti mean a
task finished. Floating "z" means the agent is paused. A "…" bubble means it is thinking.

## 6. Using it on your own repository

1. HR desk → fill **Working directory** with the **absolute path** of your repository.
2. Tick **git worktree** to give the agent its own checkout under `~/.deskhaven/worktrees/<name>-<id>` on a
   new branch `deskhaven/<name>-<id>`, created from your repository's current commit. The agent runs and
   edits only there (if the working directory is a subfolder of the repository, such as `repo/src`, the
   worktree still covers the whole repository but the agent works in, and may only edit, the same
   subfolder inside it); your own working copy stays untouched, and several engineers can work in parallel on
   the same repository. Hiring fails with a clear error if the folder is not a git repository. Uncommitted
   changes in your checkout are *not* copied into the worktree (the Feed shows a warning when there are
   some). **Fire** removes the worktree folder. The branch stays unless you tick **Also delete the
   branch if it is already merged**, which runs `git branch -d` (never a force delete): a branch that
   still has work is kept and the app warns you. If the worktree has uncommitted
   changes, firing is refused and the app asks before forcing it. If you moved or deleted the source
   repository, Deskhaven cannot check the worktree, so firing is refused the same way; forcing it deletes
   the worktree folder directly (run `git worktree prune` in a moved repository to drop its stale entry). A worktree agent's repository cannot be
   changed afterwards: fire it and hire a new one.
3. Choose the role. Start with **Reviewer** or **Architect** (read-only) to see how it behaves before you
   let an **Engineer** edit.
4. Keep the permission mode on **ask** for the first session, and lower the agent's daily cap in
   **Advanced** (for example 2 USD) so a runaway task stops early.
5. Create a small, concrete task and assign it. When the task is in **Review** or **Done** and the
   assignee has a worktree, the task detail shows **Merge**: the branch, how far ahead it is, and the
   files. **Accept & merge** asks you to confirm, then commits whatever is still uncommitted in the
   worktree and integrates that branch into the base branch recorded when the agent was hired. If
   your checkout is on a different branch, or in detached HEAD, the merge is refused (`wrong_branch`)
   and nothing is switched for you. The default is a squash commit (one commit per
   merge, easy to undo); choose **Merge commit (--no-ff)** if you want a merge commit instead.
   Deskhaven never switches your branch and never merges into a checkout that has uncommitted tracked
   changes — it refuses with a clear error and leaves your files as they were. Worktree commits skip
   git hooks (`core.hooksPath` is cleared and `--no-verify` is passed) and are not GPG-signed, because
   those hooks live in a tree the agent can edit. The merge commit in your source checkout still
   uses your signing setup and may run hook scripts from `core.hooksPath` (including scripts the
   agent added on its branch under a relative path such as `.husky`). The merge preview warns when
   hook files would change; Deskhaven refuses with `hooks_changed` unless you explicitly allow
   hook changes on that merge, or choose **merge without hooks** (the source merge commit uses
   `core.hooksPath=/dev/null` and `--no-verify`). Skipping hooks does not remove hook files from
   your checkout — new or updated hooks from the branch stay installed and will run on later
   commits. The merge preview records the branch commit and hook paths you consent to; if the
   worktree or hook set changes before you merge, Deskhaven refuses with `merge_preview_stale` or
   `hooks_changed`. Detection follows `core.hooksPath` (including
   symlinked directories and non-ASCII paths), `.husky`, and obeys `core.ignorecase` on
   case-insensitive volumes. If git cannot compute the merge diff, the merge is refused
   (`hooks_verify_failed`) instead of proceeding blindly. Even when no hook *files* change, the
   preview warns when hook-runner config changes (`package.json`, lint-staged, lefthook,
   pre-commit, and similar): an unchanged `pre-commit` script can still run new commands from
   those files during your merge commit. Hook scripts that only `source` other files are not
   scanned; treat those helpers as residual risk. If the worktree HEAD is no longer its `deskhaven/…` branch,
   the merge is refused (`worktree_moved`) so that work is not committed somewhere else and then
   discarded. An already-integrated branch returns `nothing_to_merge` and the task stays unmerged.
   A conflict is aborted automatically (your checkout is unchanged); the dialog lists the files and
   offers **Ask agent to resolve**, which tells the agent to integrate your branch inside its own
   worktree, and **Copy git commands** if you would rather finish the merge yourself. The merge covers
   every change on that agent's branch, not only the one task, because the worktree belongs to the
   agent. After a successful merge the worktree is realigned to your branch so the next task starts
   clean, and the card shows `merged` plus the short commit id. **Only mark done** skips git.
   To have someone else read the work first, use **Request review** (or **Review work of** on a new
   task). The reviewer is pointed at the engineer's worktree and diff, and still cannot edit it.
   `git log` and `git diff` in the worktree directory work as usual.

If the repository contains a `CLAUDE.md`, agents load it (project settings only; your personal
`~/.claude` settings and MCP servers are deliberately not loaded into agents).

## 7. Settings and limits

**Settings → Limits** (defaults in parentheses):

| Setting | Effect |
|---|---|
| Concurrent agents (2 in subscription mode, 4 with an API key) | How many agents may be busy at once. Idle agents do not count. Extra work waits. |
| Daily cost cap (20 USD, estimate) | New work is refused once today's estimated cost reaches the cap; the task goes to **Needs input** with the reason. |
| Permission timeout (10 min, at most 24 h) | Unanswered approval requests are denied after this long. |
| Stop idle processes after (15 min, 0 = never) | Frees memory; the session id is kept so the agent resumes later. |
| Sounds | Master switch, volume and per-sound toggles. |

Per-agent daily caps, max turns and the per-session budget are in the agent's **Advanced** section. The
**Kill switch** in the top bar interrupts every running turn, stops all agent processes and refuses new
work until you reset it.

## 8. Configuration reference

Environment variables are read by the server at start. `AGENTHOTEL_*` (the name before the rename) is still
accepted for every variable below.

| Variable | Default | Meaning |
|---|---|---|
| `DESKHAVEN_PORT` | `8787` | Server port. |
| `DESKHAVEN_HOST` | `127.0.0.1` | Bind address. A non-loopback address (e.g. `0.0.0.0`) is refused unless `DESKHAVEN_ALLOW_REMOTE=1`; subscription mode always refuses it. See section 11. |
| `DESKHAVEN_ALLOW_REMOTE` | unset | `1` accepts a non-loopback `DESKHAVEN_HOST` (logs a warning; the session token is required as always). |
| `DESKHAVEN_ALLOWED_HOSTS` | unset | Comma-separated extra `Host` names the server answers to (`box.lan` or `box.lan:8787`), besides `localhost`, `127.0.0.1`, `[::1]` and, on a remote bind, the machine's interface addresses. |
| `DESKHAVEN_SESSION_TOKEN` | random per launch | Fixes the session token instead of generating one at start (for scripts; keep it secret). Must be at least 32 characters, or the server exits with an error; `openssl rand -base64 32` makes one. |
| `DESKHAVEN_DEV_WEB_PORT` | `5173` | Port of the Vite dev server whose origin is accepted outside production. |
| `DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS` | unset | `1` lets API key mode run agents without `ANTHROPIC_API_KEY` on whatever credentials Claude Code finds (section 3). Bedrock, Vertex, Foundry and a project `apiKeyHelper` are recognised without it. |
| `DESKHAVEN_DATA_DIR` | `~/.deskhaven` | Data directory. An existing `~/.agenthotel` is reused until `~/.deskhaven` exists. |
| `DESKHAVEN_DB` | `<data dir>/deskhaven.db` | SQLite file (`:memory:` for throwaway runs). |
| `DESKHAVEN_WEB_DIST` | unset | Directory of the built UI to serve from the server port (see section 9). A relative path is resolved from the repository root; a missing folder or `index.html` is logged as an error at start. |
| `DESKHAVEN_KEYSTORE` | `keyring` | `memory` keeps pasted API keys in memory only (no OS keychain). |
| `DESKHAVEN_PROBE_ON_BOOT` | `1` | `0` skips the login probe at start. |
| `DESKHAVEN_ENABLE_SUBSCRIPTION_MODE` | `1` | `0` disables subscription mode. |
| `DESKHAVEN_RECORD_SDK` | unset | Path of a JSONL file that records raw SDK traffic (used to create test fixtures). |
| `ANTHROPIC_API_KEY` | unset | Used in API key mode. |
| `VITE_RENDERER` | `three` | Build-time default renderer for the web app: `three` or `pixi`. |

Data layout under `~/.deskhaven/`: `deskhaven.db` (agents, tasks, rooms, settings, event log, daily usage),
`worktrees/` (one folder per worktree agent) and `sample-repo/`. Claude Code itself keeps the session
transcripts under `~/.claude/projects/`; Deskhaven stores only the session ids.

## 9. Running a built copy

`pnpm dev` is for development (hot reload; editing server files restarts the server and ends running
agent processes, though sessions stay resumable). To run without the dev tooling:

```bash
pnpm build                                  # type-checks and builds apps/web/dist
DESKHAVEN_WEB_DIST=apps/web/dist pnpm start # one process: http://127.0.0.1:8787
```

`DESKHAVEN_WEB_DIST` may be relative (resolved from the repository root, whatever folder `pnpm start` runs
the server in) or absolute, e.g. `DESKHAVEN_WEB_DIST="$PWD/apps/web/dist"`.

Do not expose the port to a network: agents can run commands on your machine under the permission rules
above. Section 11 explains what keeps other websites out and what `DESKHAVEN_ALLOW_REMOTE` changes.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `ERR_PNPM_UNSUPPORTED_ENGINE` or "Unsupported engine" | Node.js is older than 22. Install and select Node 22: `nvm install 22 && nvm use 22`, or `fnm use` in the repository root (`.nvmrc` is `22`). |
| `pnpm: command not found` or the wrong version | `corepack enable`, then `corepack prepare pnpm@10.34.5 --activate`. If either fails with `EACCES`, use the user-local install from section 1 (`npm install -g --prefix ~/.local pnpm@10.34.5`). |
| `corepack enable` fails with `EACCES` | Node is installed system-wide; use the user-local install in section 1: `npm install -g --prefix ~/.local pnpm@10.34.5` and put `~/.local/bin` on `PATH`. |
| `corepack enable --install-directory ...` still fails with `EACCES` | `COREPACK_HOME` points to a root-owned folder. Set `COREPACK_HOME="$HOME/.cache/corepack"` (section 1), or use the npm install above. |
| `Could not locate the bindings file` for `better-sqlite3` | Your platform has no prebuilt binary (anything but Linux, macOS or Windows on x64/arm64). Install the build tools (macOS: `xcode-select --install`; Linux: `make`, `g++` and `python3`, e.g. `build-essential`) and run `pnpm rebuild better-sqlite3`. Node must be 22+. |
| Install seems stuck | The first install downloads the 230 MB native `claude` binary; wait, or check your network. |
| Port 5173 or 8787 already in use | Stop the other process, or set `DESKHAVEN_PORT` (and change the proxy target in `apps/web/vite.config.ts`). |
| Settings says "not logged in" in subscription mode | Run `claude login` in a terminal, then reopen Settings. Check with `claude auth status`. |
| An agent stops with "apiKeySource" or key error in subscription mode | An API key reached the agent process. Unset `ANTHROPIC_API_KEY` for the shell that starts the server, or use API key mode. |
| An agent goes to error with "no API key is configured" | API key mode is selected but there is no key. Add one in Settings (running agents pick it up on their next task) or switch to subscription mode. Deskhaven refuses to start the agent rather than let the CLI fall back to other credentials. Using Bedrock, Vertex or an `apiKeyHelper`? See section 3. |
| An agent shows "Invalid working directory" | It was saved with a folder that is now refused (for example `/`, from before workdir validation existed) or its folder or worktree is gone. It cannot start until you click **Change working directory** in the Inspector and pick a project folder, or **Fire** it. |
| The UI shows 401/403 errors, or curl gets `forbidden_host` / `unauthorized` | Open the app at `http://127.0.0.1:5173` (dev) or `:8787` (built) rather than another hostname, or add the name to `DESKHAVEN_ALLOWED_HOSTS`. Scripts need the session token (section 11). |
| 401 or 429 emotes | 401: re-authenticate or fix the key. 429: you hit a rate limit; the avatar shows a cooldown and work resumes after the window. |
| Black room or "WebGL" errors | Enable hardware acceleration in your browser, or switch to the pixel renderer in Settings → Renderer. |
| Room looks right but characters are capsules | The character model failed to load (check the network tab for `/models/characters/rogue.glb`). Capsules are the deliberate fallback. |
| An agent never moves | Check the Feed and the Inspector: it may be waiting for a permission answer, or the concurrency cap is full. |
| Everything is stuck after "Kill switch" | Reset the kill switch from the top bar before assigning new work. |
| Layout import is rejected | Layouts are validated before they are saved (overlaps, pieces outside the room, unreachable stations). Fix the JSON or place the pieces in the editor instead. |
| Want a clean slate | Stop the server and delete `~/.deskhaven` (or point `DESKHAVEN_DATA_DIR` at a new folder). This removes agents, tasks and the event log. |

## 11. Safety and cost

### Network security: what keeps other websites out

Binding to `127.0.0.1` on its own did **not** protect the server. Your browser runs code from every site
you visit, and that code can reach `127.0.0.1`:

- **Cross-site WebSocket hijacking.** Browsers do not apply CORS to WebSockets. Any page could open
  `ws://127.0.0.1:8787/ws` and read every agent, working directory, task, prompt and event.
- **DNS rebinding.** A domain such as `rebind.attacker.example` can resolve to `127.0.0.1` after the page
  loads; the page is then "same origin" with the API and can create an agent with workdir `/` and Bash,
  Write and Edit auto-approved.
- **CSRF.** "Simple" cross-site requests (`text/plain` POSTs, form posts) reach the server without a CORS
  preflight, e.g. a POST to `/api/kill`.

Every request now passes these checks, in order:

1. **Host allow-list**: only `localhost`, `127.0.0.1` and `[::1]` on the server port (plus the Vite port
   during `pnpm dev`, and `DESKHAVEN_ALLOWED_HOSTS`). A rebinding domain sends its own name in `Host` and
   gets 403.
2. **Origin check** on the WebSocket and on every POST, PUT, PATCH and DELETE: the `Origin` (or `Referer`)
   must be one of the allowed hosts. A browser request with neither, or marked `cross-site` by fetch
   metadata, gets 403.
3. **JSON only**: writes must be `Content-Type: application/json`, which no simple cross-site request can
   send (415 otherwise).
4. **Session token**: generated at each server start and required on `/api/*` and `/ws` (401 otherwise).
   The web app receives it as an `HttpOnly; SameSite=Strict` cookie from `GET /api/session`, so other
   sites can neither read it nor make the browser send it. Scripts can pass it as
   `X-Deskhaven-Token: <token>` or `Authorization: Bearer <token>`; fix it with `DESKHAVEN_SESSION_TOKEN`.
   `/api/health` stays public.

**Remote access** stays off by default. A non-loopback `DESKHAVEN_HOST` (such as `0.0.0.0`) refuses to
start unless `DESKHAVEN_ALLOW_REMOTE=1` is set; then the server logs a loud warning, prints one login URL
per reachable address on the terminal (for `0.0.0.0` every external network interface, plus each
`DESKHAVEN_ALLOWED_HOSTS` name; never `0.0.0.0` itself), and hands out the cookie only to a browser that
presents the token. Those interface addresses are accepted as `Host` automatically; if the machine has no
external interface the server exits and asks for `DESKHAVEN_ALLOWED_HOSTS`.
Anyone with the token controls agents that can run commands on your machine; there is no TLS, so use it
only on a network you trust (or behind an SSH tunnel, which needs none of this).

### Agents and cost

- Default permission mode is **ask**; there is no mode that skips all permission checks.
- Agents are confined to their working directory by a guard that denies edits outside it (symlinks are
  resolved first, so a link pointing out of the workdir does not count as inside).
- Use git worktrees for anything you care about, and review diffs before merging.
- Budgets: per-agent and global daily caps, per-session turn and spend limits, the concurrency cap and the
  kill switch. Caps use estimated costs, so leave headroom.
- Each running agent is one `claude` process (hundreds of MB of memory). Keep the cap low on small machines.
- Secrets: API keys live in the OS keychain or the environment, are redacted from logs, and are never
  stored in the database or sent to the browser.

## 12. Developing

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # the gate; also what CI runs
```

- `packages/shared`: zod schemas, event model, `mapEventToBehavior`, furniture catalog, role presets.
- `apps/server`: Fastify, WebSocket, SQLite, the only package that talks to the Agent SDK.
- `apps/web`: React UI and the two renderers under `src/game` (`core/` simulation, `three/`, `pixi/`).

Replay (section 5) is the cheapest way to test visual changes: no agents run and nothing costs money.
Read [CONTRIBUTING.md](../CONTRIBUTING.md), [ARCHITECTURE.md](../ARCHITECTURE.md) (decisions and verified SDK
facts), [CLAUDE.md](../CLAUDE.md) (commands and gotchas) and [ASSETS.md](../ASSETS.md) (art and licences).
