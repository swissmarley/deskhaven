import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isInside, realpathLoose } from '../src/agent/diff-tracker.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-guard-')));
const workdir = path.join(base, 'project');
const outside = path.join(base, 'secrets');
fs.mkdirSync(workdir);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(workdir, 'escape'));
fs.symlinkSync(workdir, path.join(base, 'project-link'));

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('workdir guard', () => {
  it('rejects a path that leaves the workdir through a symlink', () => {
    expect(isInside(workdir, path.join(workdir, 'escape', 'id_rsa'))).toBe(false);
    expect(isInside(workdir, path.join(workdir, 'escape'))).toBe(false);
  });

  it('accepts real paths inside, including files that do not exist yet', () => {
    expect(isInside(workdir, path.join(workdir, 'src', 'new-file.ts'))).toBe(true);
    expect(isInside(workdir, workdir)).toBe(true);
    expect(isInside(workdir, path.join(workdir, '..', 'secrets', 'x'))).toBe(false);
  });

  it('resolves a symlinked workdir on both sides', () => {
    const linked = path.join(base, 'project-link');
    expect(isInside(linked, path.join(workdir, 'a.ts'))).toBe(true);
    expect(isInside(workdir, path.join(linked, 'a.ts'))).toBe(true);
    expect(isInside(linked, path.join(linked, 'escape', 'k'))).toBe(false);
  });

  it('realpathLoose keeps the missing tail', () => {
    expect(realpathLoose(path.join(workdir, 'escape', 'a', 'b'))).toBe(
      path.join(outside, 'a', 'b'),
    );
  });
});
