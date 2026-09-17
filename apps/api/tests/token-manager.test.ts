import { describe, expect, it } from "vitest";
import { MockQuestradeTransport } from "../src/questrade/mock-transport.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeReauthorizationRequiredError,
  QuestradeTokenManager,
  QuestradeTokenPersistenceUncertainError,
  QuestradeTransientTokenError,
  type RefreshTokenStore,
} from "../src/questrade/token-manager.js";
import type { RawTokenGrant, TokenTransport } from "../src/questrade/types.js";

describe("QuestradeTokenManager", () => {
  it("serializes refresh and rotates the single-use refresh token", async () => {
    let now = new Date("2026-08-24T14:00:00Z");
    const transport = new MockQuestradeTransport();
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const manager = new QuestradeTokenManager(transport, store, () => now, 0);

    const initialSessions = await Promise.all([
      manager.getSession(),
      manager.getSession(),
      manager.getSession(),
    ]);
    expect(transport.authCallCount).toBe(1);
    expect(
      new Set(initialSessions.map((session) => session.accessToken)).size,
    ).toBe(1);
    expect(await store.read()).toBe("mock-refresh-token-1");

    now = new Date("2026-08-24T14:30:01Z");
    const refreshedSessions = await Promise.all([
      manager.getSession(),
      manager.getSession(),
    ]);
    expect(transport.authCallCount).toBe(2);
    expect(refreshedSessions[0]?.accessToken).toBe("mock-access-token-2");
    expect(refreshedSessions[0]?.apiServer.href).not.toBe(
      initialSessions[0]?.apiServer.href,
    );
    expect(await store.read()).toBe("mock-refresh-token-2");
  });

  it("clears the in-flight rotation marker once the replacement token is committed", async () => {
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const manager = new QuestradeTokenManager(
      new MockQuestradeTransport(),
      store,
      () => new Date(),
      0,
    );

    await manager.getSession();

    expect(await store.interruptedRotationAt()).toBeUndefined();
    expect(await store.readCandidates()).toEqual([
      "mock-refresh-token-1",
      "mock-refresh-token-0",
    ]);
  });

  it("falls back to the superseded token when the current one is rejected", async () => {
    const transport = new MockQuestradeTransport();
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    // A rotation that stored a token Questrade will not honour.
    await store.rotate("mock-refresh-token-0", "stale-token");

    const manager = new QuestradeTokenManager(
      transport,
      store,
      () => new Date(),
      0,
    );
    const session = await manager.getSession();

    expect(session.accessToken).toBe("mock-access-token-1");
    expect(await store.read()).toBe("mock-refresh-token-1");
  });

  it("reports that manual reauthorization is required when every candidate is rejected", async () => {
    const store = new InMemoryRefreshTokenStore("consumed-token");
    // A previous process died between Questrade issuing a replacement and the store committing it.
    await store.beginRotation();

    const manager = new QuestradeTokenManager(
      new MockQuestradeTransport(),
      store,
      () => new Date(),
      0,
    );

    await expect(manager.getSession()).rejects.toBeInstanceOf(
      QuestradeReauthorizationRequiredError,
    );
    await expect(manager.getSession()).rejects.toThrow(/never completed/);
    await expect(manager.getSession()).rejects.toThrow(
      /new manual authorization token is required/,
    );
  });

  it("settle waits for an in-flight rotation so shutdown cannot strand the account", async () => {
    let release!: (grant: RawTokenGrant) => void;
    let committed = false;
    const grant = new Promise<RawTokenGrant>((resolve) => {
      release = resolve;
    });
    const transport: TokenTransport = { redeemRefreshToken: () => grant };
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const manager = new QuestradeTokenManager(
      transport,
      store,
      () => new Date("2026-08-24T14:00:00Z"),
      0,
    );

    const pending = manager.getSession();
    const settled = manager.settle().then(() => {
      committed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(committed).toBe(false);

    release({
      access_token: "access",
      refresh_token: "mock-refresh-token-9",
      token_type: "Bearer",
      expires_in: 1_800,
      api_server: "https://mock-api01.iq.questrade.test/",
    });
    await settled;

    // Shutdown may only continue once the replacement token is durable.
    expect(await store.read()).toBe("mock-refresh-token-9");
    await pending;
  });

  it.each([
    ["HTTP 429", { status: 429 }],
    ["HTTP 500", { status: 500 }],
    ["a timeout", new DOMException("The operation was aborted", "AbortError")],
  ])(
    "treats %s as a transient failure, never manual reauthorization",
    async (_label, cause) => {
      const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
      const transport: TokenTransport = {
        redeemRefreshToken: () => Promise.reject(cause),
      };
      const manager = new QuestradeTokenManager(
        transport,
        store,
        () => new Date(),
        0,
      );

      await expect(manager.getSession()).rejects.toBeInstanceOf(
        QuestradeTransientTokenError,
      );
      await expect(manager.getSession()).rejects.not.toBeInstanceOf(
        QuestradeReauthorizationRequiredError,
      );
      // The candidate is retained rather than superseded by a transient failure.
      expect(await store.readCandidates()).toEqual(["mock-refresh-token-0"]);
    },
  );

  it("treats an explicit invalid-grant rejection as eligible for fallback/manual reauthorization, not transient", async () => {
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const transport: TokenTransport = {
      redeemRefreshToken: () =>
        Promise.reject(
          Object.assign(new Error("invalid_grant"), { status: 400 }),
        ),
    };
    const manager = new QuestradeTokenManager(
      transport,
      store,
      () => new Date(),
      0,
    );

    await expect(manager.getSession()).rejects.toBeInstanceOf(
      QuestradeReauthorizationRequiredError,
    );
  });

  it("reports a dedicated recovery state when the replacement token cannot be durably committed", async () => {
    let rotateCalls = 0;
    const store: RefreshTokenStore = {
      readCandidates: () => Promise.resolve(["mock-refresh-token-0"]),
      beginRotation: () => Promise.resolve(),
      rotate: () => {
        rotateCalls += 1;
        return Promise.reject(new Error("connection reset"));
      },
      interruptedRotationAt: () => Promise.resolve(undefined),
    };
    const manager = new QuestradeTokenManager(
      new MockQuestradeTransport(),
      store,
      () => new Date(),
      0,
    );

    const rejection = expect(manager.getSession()).rejects;
    await rejection.toBeInstanceOf(QuestradeTokenPersistenceUncertainError);
    await rejection.not.toBeInstanceOf(QuestradeReauthorizationRequiredError);
    expect(rotateCalls).toBeGreaterThan(0);
  });
});
