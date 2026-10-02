import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledSamplePath, ensureSampleRepo } from '../src/http/sample.js';

describe('sample repo', () => {
  it('copies the bundled sample and initialises git once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthotel-sample-'));
    const target = ensureSampleRepo(dir);
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'src/stats.ts'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect(ensureSampleRepo(dir)).toBe(target);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(path.join(bundledSamplePath(), 'README.md'))).toBe(true);
  });
});
