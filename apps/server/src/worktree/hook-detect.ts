/** Result of scanning a merge range for hook-script path changes. */
export type HookMergeCheck =
  | { ok: true; files: string[] }
  | { ok: false; code: 'verify_failed'; message: string };

export function splitNameOnlyZ(raw: string): string[] {
  if (!raw) return [];
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts.filter(Boolean);
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function normPrefix(prefix: string): string {
  return normPath(prefix).replace(/\/$/, '');
}

/** True when `filePath` is the hooks dir or a file under one of the configured prefixes. */
export function pathMatchesHookPrefix(
  filePath: string,
  prefixes: string[],
  ignoreCase: boolean,
): boolean {
  const p = normPath(filePath);
  const file = ignoreCase ? p.toLowerCase() : p;
  for (const prefix of prefixes) {
    const pre = normPrefix(prefix);
    const preCmp = ignoreCase ? pre.toLowerCase() : pre;
    if (file === preCmp || file.startsWith(`${preCmp}/`)) return true;
  }
  return false;
}

export function hookFilesFromDiffNames(
  names: string[],
  prefixes: string[],
  ignoreCase: boolean,
): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (pathMatchesHookPrefix(name, prefixes, ignoreCase)) out.push(name);
  }
  return out;
}

export async function collectHookFilesInMerge(
  loadNames: () => Promise<string[]>,
  prefixes: string[],
  ignoreCase: boolean,
): Promise<HookMergeCheck> {
  try {
    const names = await loadNames();
    return { ok: true, files: hookFilesFromDiffNames(names, prefixes, ignoreCase) };
  } catch {
    return {
      ok: false,
      code: 'verify_failed',
      message: 'Could not verify whether this merge changes git hook scripts.',
    };
  }
}

/** Paths that may run hook-adjacent code without changing files under core.hooksPath. */
export const HOOK_RUNNER_PATHS = [
  'package.json',
  '.lintstagedrc',
  '.lintstagedrc.json',
  '.lintstagedrc.yaml',
  '.lintstagedrc.yml',
  '.lintstagedrc.js',
  '.lintstagedrc.cjs',
  '.lintstagedrc.mjs',
  'lefthook.yml',
  'lefthook.yaml',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml',
] as const;

export function hookRunnerFilesInDiff(names: string[], ignoreCase: boolean): string[] {
  const wanted = new Set(HOOK_RUNNER_PATHS.map((p) => (ignoreCase ? p.toLowerCase() : p)));
  const out: string[] = [];
  for (const name of names) {
    const base = normPath(name);
    const cmp = ignoreCase ? base.toLowerCase() : base;
    if (wanted.has(cmp)) out.push(name);
  }
  return out;
}
