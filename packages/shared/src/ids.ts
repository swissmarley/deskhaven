/** Stable, dependency-free id helper (works in Node 22 and modern browsers). */
export function newId(): string {
  return crypto.randomUUID();
}
