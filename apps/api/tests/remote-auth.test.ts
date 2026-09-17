import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import { hashOperatorPassword } from "../src/auth/password.js";

function status() {
  const probe = { check: async () => ({ status: "ok" as const }) };
  return new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
}

function extractCookie(
  setCookieHeaders: string | string[] | undefined,
  name: string,
) {
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const header of headers) {
    if (header.startsWith(`${name}=`)) {
      return header.split(";")[0]!.slice(name.length + 1);
    }
  }
  return undefined;
}

describe("W5 remote-access auth plugin", () => {
  it("stays inert in the default (non-remote) profile", async () => {
    const app = await buildApp({ statusService: status() });
    const response = await app.inject({
      method: "GET",
      url: "/api/system/status",
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects unauthenticated mutations and reads when remote access is enabled", async () => {
    const app = await buildApp({
      statusService: status(),
      remoteAccess: {
        enabled: true,
        passwordHash: hashOperatorPassword("correct-horse-battery-staple"),
      },
    });

    const unauthenticatedRead = await app.inject({
      method: "GET",
      url: "/api/system/status",
    });
    expect(unauthenticatedRead.statusCode).toBe(401);

    const unauthenticatedMutation = await app.inject({
      method: "PUT",
      url: "/api/alerts/policy",
      payload: {},
    });
    expect(unauthenticatedMutation.statusCode).toBe(401);
  });

  it("rejects an incorrect login password", async () => {
    const app = await buildApp({
      statusService: status(),
      remoteAccess: {
        enabled: true,
        passwordHash: hashOperatorPassword("correct-horse-battery-staple"),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("issues a session on correct login, allows reads with it, and requires a matching CSRF token for mutations", async () => {
    const app = await buildApp({
      statusService: status(),
      remoteAccess: {
        enabled: true,
        passwordHash: hashOperatorPassword("correct-horse-battery-staple"),
      },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "correct-horse-battery-staple" },
    });
    expect(login.statusCode).toBe(204);
    const sessionCookie = extractCookie(
      login.headers["set-cookie"],
      "tsx_session",
    );
    const csrfCookie = extractCookie(login.headers["set-cookie"], "tsx_csrf");
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();

    const authenticatedRead = await app.inject({
      method: "GET",
      url: "/api/system/status",
      headers: { cookie: `tsx_session=${sessionCookie}` },
    });
    expect(authenticatedRead.statusCode).toBe(200);

    const mutationWithoutCsrf = await app.inject({
      method: "PUT",
      url: "/api/alerts/policy",
      headers: { cookie: `tsx_session=${sessionCookie}` },
      payload: {},
    });
    expect(mutationWithoutCsrf.statusCode).toBe(403);

    const mutationWithWrongCsrf = await app.inject({
      method: "PUT",
      url: "/api/alerts/policy",
      headers: {
        cookie: `tsx_session=${sessionCookie}`,
        "x-csrf-token": "not-the-real-token",
      },
      payload: {},
    });
    expect(mutationWithWrongCsrf.statusCode).toBe(403);
  });

  it("keeps health checks reachable without a session", async () => {
    const app = await buildApp({
      statusService: status(),
      remoteAccess: {
        enabled: true,
        passwordHash: hashOperatorPassword("correct-horse-battery-staple"),
      },
    });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
  });
});
