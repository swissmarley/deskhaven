import { describe, expect, it } from 'vitest';
import { plainTextFromMarkdown } from '../src/ui/markdownPlain.js';

describe('plainTextFromMarkdown', () => {
  it('strips common markdown markers', () => {
    const plain = plainTextFromMarkdown('**Fixed:** `open_file()`\n\n- item one');
    expect(plain).toContain('Fixed:');
    expect(plain).toContain('open_file()');
    expect(plain).toContain('item one');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`');
  });
});
