import { z } from 'zod';
import { AgentStatusSchema } from './events.js';
import { isKnownModel } from './models.js';

/** Permission modes Deskhaven exposes. `bypassPermissions` is deliberately absent. */
export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const AvatarSchema = z.object({
  skin: z.string(),
  hair: z.string(),
  hairStyle: z.enum(['short', 'long', 'cap', 'bald', 'bun']).default('short'),
  shirt: z.string(),
  pants: z.string(),
  accessory: z.enum(['none', 'glasses', 'headset', 'tie', 'scarf']).default('none'),
});
export type Avatar = z.infer<typeof AvatarSchema>;

export const BudgetSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  dailyCapUsd: z.number().positive().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const UsageTotalsSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  turns: z.number(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const RolePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  model: z.string().optional(),
  /** null = the full Claude Code tool set. */
  tools: z.array(z.string()).nullable(),
  allowedTools: z.array(z.string()),
  permissionMode: PermissionModeSchema,
  additionalDirectories: z.array(z.string()).optional(),
  /** Manager presets get the delegation MCP tools. */
  manager: z.boolean().optional(),
});
export type RolePreset = z.infer<typeof RolePresetSchema>;

/** GET /api/presets entries: shipped built-ins may report a newer definition in the app bundle. */
export const RolePresetListItemSchema = RolePresetSchema.extend({
  builtinUpdatePending: z.boolean().optional(),
});
export type RolePresetListItem = z.infer<typeof RolePresetListItemSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: AvatarSchema,
  rolePresetId: z.string(),
  systemPrompt: z.string(),
  model: z.string(),
  tools: z.array(z.string()).nullable(),
  allowedTools: z.array(z.string()),
  permissionMode: PermissionModeSchema,
  workdir: z.string(),
  /**
   * `path` is the worktree root (what git operates on); `subdir` is the agent's folder inside it
   * when it was hired for a subfolder of the repository (relative, `/`-separated).
   */
  /**
   * `baseBranch` / `baseCommit` are the source checkout at hire time. Optional so agents saved
   * before merge support still parse; a missing base falls back to the branch checked out now.
   */
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      subdir: z.string().optional(),
      baseBranch: z.string().optional(),
      baseCommit: z.string().optional(),
      /** Repository root at hire time. Optional so agents saved before it existed still parse. */
      sourceRoot: z.string().optional(),
    })
    .nullable(),
  sessionId: z.string().nullable(),
  status: AgentStatusSchema,
  roomId: z.string(),
  deskId: z.string().nullable(),
  budget: BudgetSchema,
  currentTaskId: z.string().nullable(),
  usage: UsageTotalsSchema,
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Prefix of `Agent.lastError` when the agent cannot run because its working directory is invalid
 * (e.g. an agent saved before workdir validation existed, with workdir "/"). The UI keys off it.
 */
export const WORKDIR_ERROR_PREFIX = 'Invalid working directory: ';

/** The directory an agent works in: its worktree (plus subfolder) or its workdir. */
export function agentCwd(agent: Pick<Agent, 'workdir' | 'worktree'>): string {
  const wt = agent.worktree;
  if (!wt) return agent.workdir;
  return wt.subdir ? `${wt.path.replace(/[\\/]+$/, '')}/${wt.subdir}` : wt.path;
}

const KnownModelIdSchema = z
  .string()
  .trim()
  .min(1, 'Model must not be empty')
  .refine(isKnownModel, { message: 'Unknown model' });

/** Optional explicit model on hire; empty/whitespace is rejected. */
const AgentHireModelSchema = KnownModelIdSchema.optional();

/** Clear to Default (`null` / `''`) or set a known id. */
const AgentPatchModelSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = v.trim();
    if (t === '') return null;
    return t;
  })
  .pipe(
    z.union([
      z.undefined(),
      z.null(),
      z.string().min(1).refine(isKnownModel, { message: 'Unknown model' }),
    ]),
  );

export const CreateAgentSchema = AgentSchema.pick({
  name: true,
  avatar: true,
  rolePresetId: true,
  systemPrompt: true,
  tools: true,
  allowedTools: true,
  permissionMode: true,
  workdir: true,
  budget: true,
})
  .partial({
    systemPrompt: true,
    tools: true,
    allowedTools: true,
    permissionMode: true,
    budget: true,
    avatar: true,
  })
  .extend({
    /** Whitespace-only names are rejected; surrounding whitespace is trimmed. */
    name: z.string().trim().min(1, 'Name must not be empty').max(80),
    model: AgentHireModelSchema,
    useWorktree: z.boolean().default(false),
    roomId: z.string().optional(),
  });
export type CreateAgent = z.infer<typeof CreateAgentSchema>;

export const UpdateAgentSchema = CreateAgentSchema.omit({ useWorktree: true, model: true })
  .partial()
  .extend({
    deskId: z.string().nullable().optional(),
    model: AgentPatchModelSchema,
  })
  .partial({ model: true });
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;

export const TaskStatusSchema = z.enum([
  'backlog',
  'assigned',
  'in_progress',
  'needs_input',
  'review',
  'done',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const FileChangeSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

/** How a task's branch was integrated into the source checkout. Absent on tasks saved before merge. */
export const MergeStrategySchema = z.enum(['squash', 'merge']);
export type MergeStrategy = z.infer<typeof MergeStrategySchema>;

export const TaskMergeSchema = z.object({
  status: z.enum(['merged', 'conflict', 'failed']),
  strategy: MergeStrategySchema,
  branch: z.string(),
  targetBranch: z.string(),
  commit: z.string().nullable().optional(),
  conflictFiles: z.array(z.string()).optional(),
  error: z.string().nullable().optional(),
  mergedAt: z.number().nullable().optional(),
});
export type TaskMerge = z.infer<typeof TaskMergeSchema>;

/**
 * Who a review task should read. The agent, path and branch are recorded when the task is created
 * so they stay readable after the engineer is fired. The diff itself is taken when the review is
 * dispatched. Nullable/optional so older task rows still load.
 */
export const ReviewTargetSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
});
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

/** Default squash/merge subject. Shared so the server and the copy-commands panel stay identical. */
export function defaultMergeMessage(task: { id: string; title: string }): string {
  const title = task.title.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `deskhaven: ${title} (task ${task.id})`;
}

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  status: TaskStatusSchema,
  assigneeAgentId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  resultSummary: z.string().nullable(),
  filesChanged: z.array(FileChangeSchema),
  costUsd: z.number(),
  position: z.number(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  updatedAt: z.number(),
  merge: TaskMergeSchema.nullable().optional(),
  reviewTarget: ReviewTargetSchema.nullable().optional(),
  /** Bumped on each assign; stale dispatch failures must not roll back a newer assign. */
  dispatchSeq: z.number().int().nonnegative().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title must not be empty'),
  prompt: z.string().min(1),
  assigneeAgentId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  /** Engineer (id) whose checkout this task reviews. */
  reviewOfAgentId: z.string().nullable().optional(),
  /** Task whose assignee is the engineer to review, when the caller has a task id rather than an agent id. */
  reviewOfTaskId: z.string().nullable().optional(),
});
export type CreateTask = z.infer<typeof CreateTaskSchema>;

export const MergeTaskSchema = z.object({
  strategy: MergeStrategySchema.optional(),
  message: z.string().trim().min(1).max(500).optional(),
  /** When false or omitted, a merge that changes hook scripts under core.hooksPath is refused. */
  allowHookChanges: z.boolean().optional(),
  /** When true, the source merge commit skips git hooks (`core.hooksPath=/dev/null`, `--no-verify`). */
  skipHooks: z.boolean().optional(),
  /** Worktree `HEAD` from the merge preview; must still match at merge time. */
  expectedBranchSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  /** Hook paths the user consented to from the preview; must match the current hook set. */
  consentedHookFiles: z.array(z.string()).optional(),
  /** Tree hash of the staged worktree content from the merge preview (`write-tree` after `add -A`). */
  previewTree: z.string().regex(/^[0-9a-f]{40}$/i),
});
export type MergeTask = z.infer<typeof MergeTaskSchema>;

export const MergeFileSchema = z.object({
  path: z.string(),
  status: z.string(),
});

export const MergePreviewSchema = z.object({
  branch: z.string(),
  targetBranch: z.string(),
  sourceRoot: z.string(),
  worktreePath: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirty: z.boolean(),
  files: z.array(MergeFileSchema),
  canMerge: z.boolean(),
  reason: z.string().optional(),
  hookFiles: z.array(z.string()).optional(),
  hooksWarning: z.string().optional(),
  runnerFiles: z.array(z.string()).optional(),
  runnerWarning: z.string().optional(),
  branchSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
  previewTree: z.string().regex(/^[0-9a-f]{40}$/i),
});
export type MergePreview = z.infer<typeof MergePreviewSchema>;

export const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title must not be empty').optional(),
  prompt: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
  assigneeAgentId: z.string().nullable().optional(),
  position: z.number().optional(),
});
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

export const FurnitureKindSchema = z.enum([
  'desk',
  'chair',
  'bookshelf',
  'server_rack',
  'coffee_machine',
  'sofa',
  'plant',
  'whiteboard',
  'library_pc',
  'door',
  'rug',
]);
export type FurnitureKind = z.infer<typeof FurnitureKindSchema>;

export const FurnitureSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  kind: FurnitureKindSchema,
  x: z.number().int(),
  y: z.number().int(),
  rotation: z.number().int().min(0).max(3),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Furniture = z.infer<typeof FurnitureSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  width: z.number().int().min(4).max(40),
  height: z.number().int().min(4).max(40),
  /** Floor tile style ids, row-major, length width*height. */
  floor: z.array(z.number().int()),
  /** Wall style ids for the north wall (length width) then the west wall (length height). */
  walls: z.array(z.number().int()),
  furniture: z.array(FurnitureSchema),
  updatedAt: z.number(),
});
export type Room = z.infer<typeof RoomSchema>;

export const AuthModeSchema = z.enum(['API_KEY', 'CLAUDE_SUBSCRIPTION']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

/**
 * Upper bound for the permission timeout: 24 h. Node timers overflow above 2^31-1 ms (~24.8 days) and
 * fire after ~1 ms, which would auto-deny every permission request.
 */
export const MAX_PERMISSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const SettingsSchema = z.object({
  authMode: AuthModeSchema,
  subscriptionModeEnabled: z.boolean(),
  concurrencyCap: z.number().int().min(1).max(16),
  dailyCapUsd: z.number().nonnegative(),
  permissionTimeoutMs: z.number().int().positive().max(MAX_PERMISSION_TIMEOUT_MS),
  /** Idle Claude Code processes are stopped (session kept for resume) after this many minutes; 0 = never. */
  idleTimeoutMinutes: z.number().int().min(0).max(1440).default(15),
  soundEnabled: z.boolean(),
  policyCheckedAt: z.string(),
  onboarded: z.boolean(),
  defaultModel: z.string(),
  managerModel: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const UpdateSettingsSchema = SettingsSchema.partial();

export const AuthStatusSchema = z.object({
  mode: AuthModeSchema,
  available: z.boolean(),
  loggedIn: z.boolean().optional(),
  subscriptionType: z.string().optional(),
  email: z.string().optional(),
  keySource: z.enum(['env', 'keychain', 'none']).optional(),
  notice: z.string().optional(),
  bindHost: z.string(),
  subscriptionModeEnabled: z.boolean(),
  policyCheckedAt: z.string(),
  error: z.string().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const RateLimitWindowSchema = z.object({
  windowType: z.string(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  utilization: z.number().optional(),
  resetsAt: z.number().optional(),
});

export const UsageSnapshotSchema = z.object({
  authModeInUse: z.string(),
  totals: UsageTotalsSchema,
  today: UsageTotalsSchema,
  perAgent: z.record(z.string(), UsageTotalsSchema),
  rateLimits: z.array(RateLimitWindowSchema),
  killSwitch: z.boolean(),
  running: z.number().int(),
  concurrencyCap: z.number().int(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const PermissionRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  taskId: z.string().nullable(),
  toolUseId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  hasSuggestions: z.boolean(),
  status: z.enum(['pending', 'resolved']),
  decision: z.enum(['allow', 'allow_session', 'deny', 'timeout']).nullable(),
  message: z.string().nullable(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const ResolvePermissionSchema = z.object({
  decision: z.enum(['allow', 'allow_session', 'deny']),
  message: z.string().optional(),
});

export const emptyUsage = (): UsageTotals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
});
