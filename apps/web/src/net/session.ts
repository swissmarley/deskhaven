/**
 * The server hands each launch a session token as an HttpOnly SameSite=Strict cookie
 * (`GET /api/session`). Every API call and WebSocket connect waits for it. On a remote bind the
 * token arrives once as `?token=` in the login URL; it is forwarded and then removed from the
 * address bar.
 */
let pending: Promise<void> | null = null;

export function ensureSession(): Promise<void> {
  if (!pending) {
    pending = fetchSession().catch((err: unknown) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Forget the cached session (a restarted server issues a new token); the next call re-fetches. */
export function invalidateSession(): void {
  pending = null;
}

async function fetchSession(): Promise<void> {
  const here = new URL(location.href);
  const token = here.searchParams.get('token');
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const res = await fetch(`/api/session${query}`, { credentials: 'same-origin' });
  if (token) {
    here.searchParams.delete('token');
    history.replaceState(history.state, '', here.toString());
  }
  if (!res.ok) throw new Error(`session: ${res.status} ${res.statusText}`);
}
