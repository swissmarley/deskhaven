import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forbiddenWorkdirs, validateWorkdir } from '../src/agents/service.js';
import { type Built, client, testApp } from './helpers.js';

let built: Built;
let req: ReturnType<typeof client>;
let project: string;

beforeAll(async () => {
  built = await testApp();
  req = client(built);
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-proj-')));
});
afterAll(async () => {
  await built.app.close();
});

const hire = (over: Record<string, unknown>) =>
  req({
    method: 'POST',
    url: '/api/agents',
    payload: { name: 'Ada', rolePresetId: 'engineer', workdir: project, ...over },
  });

describe('agent input validation', () => {
  it('rejects empty and whitespace-only names, trims the rest', async () => {
    for (const name of ['', '   ', '\t\n']) {
      expect((await hire({ name })).statusCode, JSON.stringify(name)).toBe(400);
    }
    const ok = await hire({ name: '  Ada  ' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().name).toBe('Ada');
    const rename = await req({
      method: 'PATCH',
      url: `/api/agents/${ok.json().id}`,
      payload: { name: '   ' },
    });
    expect(rename.statusCode).toBe(400);
  });

  it('rejects "/" and other system or home roots', async () => {
    for (const workdir of ['/', '/etc', '/usr', os.homedir()]) {
      const res = await hire({ workdir });
      expect(res.statusCode, workdir).toBe(400);
      expect(res.json().error, workdir).toMatch(/Refusing|absolute|does not exist/);
    }
  });

  it('rejects relative workdirs instead of resolving them against the server folder', async () => {
    for (const workdir of ['.', 'src', '../..']) {
      const res = await hire({ workdir });
      expect(res.statusCode, workdir).toBe(400);
      expect(res.json().error).toMatch(/absolute/);
    }
  });

  it('requires an existing directory', async () => {
    const file = path.join(project, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect((await hire({ workdir: file })).json().error).toMatch(/not a directory/);
    expect((await hire({ workdir: path.join(project, 'missing') })).json().error).toMatch(
      /does not exist/,
    );
  });

  it('stores the realpath of a symlinked workdir', async () => {
    const link = path.join(os.tmpdir(), `deskhaven-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(project, link);
    try {
      const res = await hire({ workdir: link });
      expect(res.statusCode).toBe(201);
      expect(res.json().workdir).toBe(project);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('rejects a symlink that points at a system root', () => {
    const link = path.join(os.tmpdir(), `deskhaven-root-${process.pid}-${Date.now()}`);
    fs.symlinkSync('/', link);
    try {
      expect(() => validateWorkdir(link)).toThrow(/Refusing/);
    } finally {
      fs.unlinkSync(link);
    }
    expect(forbiddenWorkdirs('/home/someone').has('/home/someone')).toBe(true);
  });
});

describe('task input validation', () => {
  it('rejects whitespace-only titles', async () => {
    const res = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '   ', prompt: 'p' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when deleting a task that does not exist', async () => {
    const res = await req({ method: 'DELETE', url: '/api/tasks/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const created = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Real', prompt: 'p' },
    });
    const del = await req({ method: 'DELETE', url: `/api/tasks/${created.json().id}` });
    expect(del.statusCode).toBe(200);
    expect(
      (await req({ method: 'DELETE', url: `/api/tasks/${created.json().id}` })).statusCode,
    ).toBe(404);
  });
});
