import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const topBarSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/ui/TopBar.tsx'),
  'utf8',
);

describe('TopBar task toggle label', () => {
  it('uses Tasks instead of Board for the toggle button', () => {
    expect(topBarSource).toContain('Tasks{taskCount');
    expect(topBarSource).not.toMatch(/>\s*Board\{taskCount/);
  });
});
