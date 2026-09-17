import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyOperatorPassword } from "./password.js";
import { SessionStore } from "./session-store.js";
import { FixedWindowRateLimiter } from "./rate-limiter.js";

const SESSION_COOKIE = "tsx_session";
const CSRF_COOKIE = "tsx_csrf";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Health checks must keep working unauthenticated -- Compose healthchecks, and an operator's own
// monitoring, have no way to hold a session cookie. Nothing sensitive is exposed by these paths.
const UNAUTHENTICATED_PATHS = new Set([
  "/health/live",
  "/health/ready",
  "/api/auth/login",
]);

export interface RemoteAuthOptions {
  passwordHash: string;
  logger?: {
    info(fields: Record<string, unknown>): void;
  };
  sessionTtlMs?: number;
  loginAttemptLimit?: number;
  loginWindowMs?: number;
  requestLimit?: number;
  requestWindowMs?: number;
  clock?: () => number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function setCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  options: { httpOnly: boolean; maxAgeSeconds: number },
): void {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    "Secure",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  reply.header("set-cookie", attributes.join("; "));
}

function clearCookie(reply: FastifyReply, name: string): void {
  reply.header(
    "set-cookie",
    `${name}=; Path=/; SameSite=Strict; Secure; Max-Age=0`,
  );
}

/** W5: session/CSRF/rate-limit/audit layer for the optional remote-access Compose profile. Never
 * registered in the default (Phase A, localhost-only) profile -- see app.ts, which only calls this
 * when config.REMOTE_ACCESS_ENABLED is true. A single operator logs in once with
 * POST /api/auth/login and everything else on the API surface (including the /ws snapshot feed
 * and every mutation) requires the resulting session cookie; mutations additionally require the
 * matching X-CSRF-Token header (double-submit cookie pattern) so a third-party site can't ride the
 * operator's cookie into a POST/PUT/PATCH/DELETE. */
export function registerRemoteAuth(
  app: FastifyInstance,
  options: RemoteAuthOptions,
): void {
  const sessions = new SessionStore(options.sessionTtlMs, options.clock);
  const loginLimiter = new FixedWindowRateLimiter(
    options.loginAttemptLimit ?? 5,
    options.loginWindowMs ?? 5 * 60_000,
    options.clock,
  );
  const requestLimiter = new FixedWindowRateLimiter(
    options.requestLimit ?? 300,
    options.requestWindowMs ?? 60_000,
    options.clock,
  );

  app.post<{ Body: { password?: unknown } }>(
    "/api/auth/login",
    async (request, reply) => {
      if (!loginLimiter.consume(request.ip)) {
        return reply
          .code(429)
          .send({ error: "Too many login attempts. Try again later." });
      }
      const password = request.body?.password;
      if (
        typeof password !== "string" ||
        !verifyOperatorPassword(password, options.passwordHash)
      ) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }
      const session = sessions.create();
      const maxAgeSeconds = Math.floor(
        (session.expiresAt - (options.clock ?? Date.now)()) / 1000,
      );
      setCookie(reply, SESSION_COOKIE, session.id, {
        httpOnly: true,
        maxAgeSeconds,
      });
      setCookie(reply, CSRF_COOKIE, session.csrfToken, {
        httpOnly: false,
        maxAgeSeconds,
      });
      return reply.code(204).send();
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (sid) sessions.destroy(sid);
    clearCookie(reply, SESSION_COOKIE);
    clearCookie(reply, CSRF_COOKIE);
    return reply.code(204).send();
  });

  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.method === "OPTIONS") return;
      if (!requestLimiter.consume(request.ip)) {
        return reply.code(429).send({ error: "Rate limit exceeded" });
      }
      if (UNAUTHENTICATED_PATHS.has(request.url.split("?")[0]!)) return;
      if (request.url.startsWith("/api/auth/")) return;

      const cookies = parseCookies(request.headers.cookie);
      const sid = cookies[SESSION_COOKIE];
      const session = sid ? sessions.get(sid) : undefined;
      if (!session) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (MUTATING_METHODS.has(request.method)) {
        const csrfHeader = request.headers["x-csrf-token"];
        if (
          typeof csrfHeader !== "string" ||
          csrfHeader !== session.csrfToken
        ) {
          return reply
            .code(403)
            .send({ error: "CSRF token missing or invalid" });
        }
      }
    },
  );

  app.addHook(
    "onResponse",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!MUTATING_METHODS.has(request.method)) return;
      options.logger?.info({
        event: "REMOTE_MUTATION_AUDIT",
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        ip: request.ip,
      });
    },
  );
}
