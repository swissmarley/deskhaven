import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

/** Guards for install instructions that broke for real users; cheap to keep honest. */
const guide = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'GUIDE.md'), 'utf8');
const section1 = guide.slice(guide.indexOf('## 1. Requirements'), guide.indexOf('## 2. '));

describe('docs/GUIDE.md install instructions', () => {
  it('recommends the npm user-local pnpm before the corepack route', () => {
    const npm = section1.indexOf('npm install -g --prefix ~/.local pnpm@10.34.5');
    const corepack = section1.indexOf('corepack enable --install-directory');
    expect(npm).toBeGreaterThan(-1);
    expect(corepack).toBeGreaterThan(npm);
  });

  it('tells corepack users to move COREPACK_HOME to a user-writable folder', () => {
    expect(section1).toMatch(/export COREPACK_HOME="\$HOME\/\.cache\/corepack"/);
    expect(guide).toMatch(/COREPACK_HOME` points to a root-owned folder/);
  });

  it('never suggests a bare `corepack enable` without the no-root fallback next to it', () => {
    const lines = guide
      .split('\n')
      .filter((l) => /corepack enable(?! --install-directory)/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.includes('writes shims next to the `node` binary')) continue; // the explanation itself
      expect(line, line).toMatch(/EACCES|user-local/);
    }
  });

  it('pins the same pnpm version as package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const version = String(pkg.packageManager).replace('pnpm@', '');
    for (const m of section1.matchAll(/pnpm@(\d+\.\d+\.\d+)/g)) expect(m[1]).toBe(version);
  });

  it('only references troubleshooting rows that exist', () => {
    for (const m of guide.matchAll(/see "([^"]+)" in section 10/g)) {
      const row = guide.includes(`| ${m[1]}`) || guide.includes(`| \`${m[1]}\``);
      expect(row, m[1]).toBe(true);
    }
  });
});

describe('Node.js 22 requirement', () => {
  it('is stated before the README quick start, in the guide, and in .nvmrc', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const requirements = readme.indexOf('Node.js 22');
    const quickStart = readme.indexOf('## Quick start');
    expect(requirements).toBeGreaterThan(-1);
    expect(requirements).toBeLessThan(quickStart);
    expect(readme).toMatch(/ERR_PNPM_UNSUPPORTED_ENGINE/);
    expect(readme).toMatch(/pnpm 10\.34\.5/);
    expect(section1).toMatch(/Node\.js/);
    expect(section1).toMatch(/\b22\b/);
    expect(section1).toMatch(/ERR_PNPM_UNSUPPORTED_ENGINE/);
    expect(guide).toMatch(/nvm install 22 && nvm use 22/);
    expect(guide).toMatch(/fnm use/);
    expect(fs.readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8').trim()).toBe('22');
  });
});
