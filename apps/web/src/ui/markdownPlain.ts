/** Plain-text preview for task cards: drop common markdown markers without parsing HTML. */
export function plainTextFromMarkdown(source: string): string {
  let text = source;
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```\w*\n?/g, '').replace(/```/g, ''),
  );
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}
