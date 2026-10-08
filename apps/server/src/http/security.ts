import crypto from 'node:crypto';
import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';

/**
 * Request gate for the HTTP API and the WebSocket. Binding to 127.0.0.1 alone does not keep other
 * websites out: a page on any origin can open a WebSocket to localhost (browsers do not apply CORS
 * to WebSockets), send "simple" cross-site POSTs, and a DNS-rebinding domain can talk to the API as
 * if it were same-origin. Every request therefore has to pass, in order:
 *
 * 1. Host allow-list (loopback names on our port, plus DESKHAVEN_ALLOWED_HOSTS): stops DNS rebinding.
 * 2. Origin / Referer allow-list for the WebSocket and every state-changing method: stops CSRF and
 *    cross-site WebSocket hijacking. A browser request without either header is refused.
 * 3. `Content-Type: application/json` on POST / PUT / PATCH / DELETE: no "simple" cross-site request
 *    (text/plain, form posts, bodiless no-cors fetches) can reach a mutating route.
 * 4. The per-launch session token (HttpOnly SameSite=Strict cookie, or a header) on /api and /ws.
 */

/**
 * Pre-port cookie name. Cookies are not scoped by port, so a single name let two instances on one
 * host (say dev on 8787 and a built copy on 8788) overwrite each other's token. Still read as a
 * fallback; never set any more.
 */
export const LEGACY_SESSION_COOKIE = 'deskhaven_session';

/** The session cookie name for a server port: `deskhaven_session_<port>`. */
export function sessionCookieName(port: number): string {
  return `${LEGACY_SESSION_COOKIE}_${port}`;
}
export const TOKEN_HEADER = 'x-deskhaven-token';

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes that work without the session token. */
const PUBLIC_API = new Set(['/api/health', '/api/session']);

export function isLoopbackAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1';
  return false;
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i;

/** Splits a Host-style value into a lowercase name (IPv6 bracketed) and port; null if malformed. */
function parseHost(value: string): { name: string; port: number | null } | null {
  const v = value.trim().toLowerCase();
  const m = HOST_RE.exec(v);
  if (!m) return null;
  if (m[1] === undefined) return { name: v, port: null };
  return { name: v.slice(0, v.length - m[1].length - 1), port: Number(m[1]) };
}

/** `name:port` (lowercase, IPv6 bracketed, port defaulted) or null when the value is not a plain host. */
export function normalizeHost(value: string, defaultPort = 80): string | null {
  const h = parseHost(value);
  return h ? `${h.name}:${h.port ?? defaultPort}` : null;
}

/** `name:port` of an http(s) Origin or Referer, or null when it is anything else ("null", file:, ...). */
export function originHost(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname.toLowerCase()}:${port}`;
}

/** Every `name:port` this server answers to. */
export function allowedHosts(
  config: Pick<ServerConfig, 'host' | 'port' | 'isProduction' | 'devWebPort' | 'allowedHosts'>,
): Set<string> {
  const ports = [config.port, ...(config.isProduction ? [] : [config.devWebPort])];
  const names = [...LOOPBACK_NAMES];
  const bind = config.host.toLowerCase();
  if (bind !== '0.0.0.0' && bind !== '::' && !isLoopbackAddress(bind))
    names.push(net.isIPv6(bind) ? `[${bind}]` : bind);
  const out = new Set<string>();
  for (const n of names) for (const p of ports) out.add(`${n}:${p}`);
  // Entries without a port ("myhost.lan") match the same ports as the loopback names.
  for (const extra of config.allowedHosts) {
    const h = parseHost(extra);
    if (!h) continue;
    if (h.port !== null) out.add(`${h.name}:${h.port}`);
    else for (const p of ports) out.add(`${h.name}:${p}`);
  }
  return out;
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Candidate tokens, in order: the X-Deskhaven-Token header, `Authorization: Bearer`, this port's
 * cookie, then the legacy unported cookie.
 */
export function presentedTokens(req: FastifyRequest, cookieName: string): string[] {
  const out: string[] = [];
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === 'string' && header) out.push(header);
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) out.push(auth.slice(7).trim());
  for (const name of [cookieName, LEGACY_SESSION_COOKIE]) {
    const c = readCookie(req.headers.cookie, name);
    if (c) out.push(c);
  }
  return out;
}

/** Heuristic for "a browser sent this": fetch metadata or a browser user agent. */
function fromBrowser(req: FastifyRequest): boolean {
  return (
    req.headers['sec-fetch-site'] !== undefined ||
    req.headers['sec-fetch-mode'] !== undefined ||
    /Mozilla\//.test(req.headers['user-agent'] ?? '')
  );
}

export interface SecurityOptions {
  config: ServerConfig;
  token: string;
}

export interface Security {
  token: string;
  /** Name of this instance's session cookie (includes the port). */
  cookieName: string;
  remote: boolean;
  hosts: Set<string>;
  hostAllowed(host: string | undefined): boolean;
  originAllowed(origin: string): boolean;
}

/**
 * Throws when the server would bind to a non-loopback address without DESKHAVEN_ALLOW_REMOTE=1.
 * Returns true when it binds remotely with the opt-in (the caller logs a warning).
 */
export function checkBindPolicy(config: Pick<ServerConfig, 'host' | 'allowRemote'>): boolean {
  if (isLoopbackAddress(config.host)) return false;
  if (!config.allowRemote)
    throw new Error(
      `Refusing to listen on ${config.host}: Deskhaven runs agents with shell access and is meant for ` +
        'loopback only. Set DESKHAVEN_ALLOW_REMOTE=1 (and DESKHAVEN_ALLOWED_HOSTS) to accept the risk.',
    );
  return true;
}

export function registerSecurity(app: FastifyInstance, opts: SecurityOptions): Security {
  const { config, token } = opts;
  const remote = checkBindPolicy(config);
  const hosts = allowedHosts(config);
  const cookieName = sessionCookieName(config.port);
  const hasToken = (candidates: string[]) => candidates.some((t) => sameToken(t, token));
  const sec: Security = {
    token,
    cookieName,
    remote,
    hosts,
    hostAllowed: (host) => {
      if (!host) return false;
      const h = normalizeHost(host);
      return h !== null && hosts.has(h);
    },
    originAllowed: (origin) => {
      const h = originHost(origin);
      return h !== null && hosts.has(h);
    },
  };
  if (remote)
    app.log.warn(
      { host: config.host, allowedHosts: [...hosts] },
      '!!! Deskhaven is listening on a NON-LOOPBACK address. Anyone who can reach this port and ' +
        'holds the session token controls agents with shell access on this machine. !!!',
    );

  // An empty body is valid for bodiless JSON calls (stop, kill, ...): every mutating request must
  // carry Content-Type: application/json, so the parser has to accept "no payload".
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, undefined);
    jsonParser(req, text, done);
  });

  const deny = (reply: FastifyReply, code: number, error: string) =>
    reply.code(code).send({ error });

  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? req.url;
    const isWs = pathname === '/ws' || pathname.startsWith('/ws/');
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const mutating = !SAFE_METHODS.has(req.method);

    if (!sec.hostAllowed(req.headers.host)) return deny(reply, 403, 'forbidden_host');

    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!sec.originAllowed(origin)) return deny(reply, 403, 'forbidden_origin');
    } else if (mutating || isWs) {
      const referer = req.headers.referer;
      if (referer !== undefined) {
        if (!sec.originAllowed(referer)) return deny(reply, 403, 'forbidden_origin');
      } else if (fromBrowser(req)) return deny(reply, 403, 'missing_origin');
    }
    if ((isApi || isWs) && req.headers['sec-fetch-site'] === 'cross-site')
      return deny(reply, 403, 'forbidden_origin');

    if (mutating) {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (ct !== 'application/json') return deny(reply, 415, 'content_type_must_be_json');
    }

    if ((isApi && !PUBLIC_API.has(pathname)) || isWs) {
      if (!hasToken(presentedTokens(req, cookieName))) return deny(reply, 401, 'unauthorized');
    }
  });

  /**
   * Hands the session token to the web app as an HttpOnly SameSite=Strict cookie. On loopback any
   * same-origin page load may ask (cross-site callers were refused above and cannot read the cookie);
   * a remote bind additionally needs the token itself (`?token=` from the startup URL).
   */
  app.get('/api/session', async (req, reply) => {
    if (remote) {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const candidates = presentedTokens(req, cookieName);
      if (typeof q.token === 'string') candidates.unshift(q.token);
      if (!hasToken(candidates)) return deny(reply, 401, 'token_required');
    }
    const secure = req.protocol === 'https' ? '; Secure' : '';
    void reply.header(
      'set-cookie',
      `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`,
    );
    return { ok: true };
  });

  return sec;
}
