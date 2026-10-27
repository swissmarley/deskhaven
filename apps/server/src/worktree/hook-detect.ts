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
  return [...new Set(out)].sort();
}

export function hookFileSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
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

/** Basenames (or full relative paths) of files that can change what hooks run. */
export const HOOK_RUNNER_BASENAME =
  /^(?:package\.json|\.lintstagedrc(?:\..+)?|lint-staged\.config\..+|lefthook(?:-local)?\.(?:ya?ml)|\.lefthook(?:\..*)?|commitlint\.config\..+|\.commitlintrc(?:\..+)?|\.huskyrc(?:\..+)?|simple-git-hooks\.(?:ya?ml|json)|\.pre-commit-config\.(?:ya?ml|yml))$/i;

export function isHookRunnerPath(filePath: string, ignoreCase: boolean): boolean {
  const norm = normPath(filePath);
  const parts = norm.split('/');
  const base = parts.at(-1) ?? '';
  const baseCmp = ignoreCase ? base.toLowerCase() : base;
  if (baseCmp === 'package.json') return true;
  if (norm.includes('/.config/lefthook.')) return true;
  if (norm.includes('/.lefthook/')) return true;
  return HOOK_RUNNER_BASENAME.test(baseCmp);
}

export function hookRunnerFilesInDiff(names: string[], ignoreCase: boolean): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (isHookRunnerPath(name, ignoreCase)) out.push(name);
  }
  return [...new Set(out)].sort();
}
