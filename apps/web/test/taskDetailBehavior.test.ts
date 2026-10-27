import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const taskDetailSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/ui/TaskDetail.tsx'),
  'utf8',
);

describe('TaskDetail assignee UI', () => {
  it('labels the empty assignee option for unassigning', () => {
    expect(taskDetailSource).toContain('— Unassign (back to backlog) —');
    expect(taskDetailSource).not.toContain('<option value="">unassigned</option>');
  });

  it('closes the modal when opening the inspector', () => {
    expect(taskDetailSource).toMatch(/selectAgent\([^)]+\);\s*\n\s*onClose\(\)/);
  });
});
