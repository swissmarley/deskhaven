/**
 * Ports for `pnpm dev`, read from the same variables as the server: DESKHAVEN_PORT (the API the Vite
 * proxy forwards to, default 8787) and DESKHAVEN_DEV_WEB_PORT (the Vite dev server, default 5173),
 * with the old AGENTHOTEL_* names as fallback. The server allows the dev web port as an origin, so
 * both sides must agree; changing vite.config.ts by hand used to be the only way.
 */
export function devPorts(env: Record<string, string | undefined>): { api: number; web: number } {
  const read = (name: string, fallback: number) => {
    const raw = env[`DESKHAVEN_${name}`] ?? env[`AGENTHOTEL_${name}`];
    const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
  };
  return { api: read('PORT', 8787), web: read('DEV_WEB_PORT', 5173) };
}
