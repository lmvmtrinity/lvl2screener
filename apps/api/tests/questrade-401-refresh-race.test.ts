import { describe, expect, it } from "vitest";
import { QuestradeAdapter } from "../src/questrade/adapter.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeTokenManager,
} from "../src/questrade/token-manager.js";
import { MockQuestradeTransport } from "../src/questrade/mock-transport.js";
import { QuestradeHttpError } from "../src/questrade/live-transport.js";
import type {
  AuthSession,
  QuestradeTransport,
  TokenTransport,
} from "../src/questrade/types.js";

/**
 * Proves the stale-session refresh race described in the hardening task:
 * - Startup launches many broker requests concurrently with session A.
 * - Several requests receive delayed 401 responses for A.
 * - The first response rotates to session B.
 * - A later response for A arriving after the refresh must NOT rotate again.
 */
describe("Questrade stale-session 401 race", () => {
  it("staggered concurrent 401s for one rejected session cause one refresh", async () => {
    const tokenTransport = new MockQuestradeTransport();
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const tokenManager = new QuestradeTokenManager(
      tokenTransport,
      store,
      () => new Date(),
      0,
    );
    const initial = await tokenManager.getSession();
    const initialToken = initial.accessToken;

    // Wrap the mock transport so quote calls fail with 401 when they present
    // the initial session, with the second failure delayed until after the
    // first refresh has completed. Success requires the rotated session.
    let callsWithInitial = 0;
    const transport: QuestradeTransport & TokenTransport = {
      redeemRefreshToken: (token: string) =>
        tokenTransport.redeemRefreshToken(token),
      searchSymbols: (...args) =>
        (tokenTransport as QuestradeTransport).searchSymbols(...args),
      getSymbolDetails: (...args) =>
        (tokenTransport as QuestradeTransport).getSymbolDetails(...args),
      getQuotes: async (apiServer, accessToken, symbolIds) => {
        if (accessToken === initialToken) {
          callsWithInitial += 1;
          if (callsWithInitial === 1) {
            throw new QuestradeHttpError(401, "quotes");
          }
          // Delayed 401 for the same rejected session A: wait until the first
          // refresh has installed session B, then report the stale rejection.
          while (tokenTransport.authCallCount < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          // Ensure the refresh has fully settled (session B installed).
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new QuestradeHttpError(401, "quotes");
        }
        return (tokenTransport as QuestradeTransport).getQuotes(
          apiServer,
          accessToken,
          symbolIds,
        );
      },
      getCandles: (...args) =>
        (tokenTransport as QuestradeTransport).getCandles(...args),
      getMarkets: (...args) =>
        (tokenTransport as QuestradeTransport).getMarkets(...args),
    };

    const adapter = new QuestradeAdapter(
      tokenManager,
      transport,
      () => new Date(),
      "QUESTRADE_MOCK",
    );

    const results = await Promise.all([
      adapter.getQuotes([1001]),
      adapter.getQuotes([1002]),
    ]);
    expect(results[0]).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    // One initial redeem + exactly one refresh for the single rejected session.
    expect(tokenTransport.authCallCount).toBe(2);
  });

  it("a delayed old-session 401 reuses the newer session without rotating again", async () => {
    const tokenTransport = new MockQuestradeTransport();
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const manager = new QuestradeTokenManager(
      tokenTransport,
      store,
      () => new Date(),
      0,
    );
    const sessionA = await manager.getSession();
    expect(tokenTransport.authCallCount).toBe(1);

    // First 401 for A rotates to B through the conditional boundary.
    const boundary = manager as unknown as {
      refreshAfterUnauthorized: (rejected: AuthSession) => Promise<AuthSession>;
    };
    expect(typeof boundary.refreshAfterUnauthorized).toBe("function");
    const sessionB = await boundary.refreshAfterUnauthorized(sessionA);
    expect(tokenTransport.authCallCount).toBe(2);
    expect(sessionB.accessToken).not.toBe(sessionA.accessToken);

    // Delayed duplicate 401 for the older session A must reuse B.
    const reused = await boundary.refreshAfterUnauthorized(sessionA);
    expect(reused.accessToken).toBe(sessionB.accessToken);
    expect(tokenTransport.authCallCount).toBe(2);
  });

  it("a genuine 401 against the current session may initiate one new refresh", async () => {
    const tokenTransport = new MockQuestradeTransport();
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const manager = new QuestradeTokenManager(
      tokenTransport,
      store,
      () => new Date(),
      0,
    );
    const sessionA = await manager.getSession();
    const boundary = manager as unknown as {
      refreshAfterUnauthorized: (rejected: AuthSession) => Promise<AuthSession>;
    };
    const sessionB = await boundary.refreshAfterUnauthorized(sessionA);
    // A 401 presenting the current session B is genuine and refreshes once.
    const sessionC = await boundary.refreshAfterUnauthorized(sessionB);
    expect(sessionC.accessToken).not.toBe(sessionB.accessToken);
    expect(tokenTransport.authCallCount).toBe(3);
  });

  it("persistent current-session authorization failure remains visible", async () => {
    const tokenTransport = new MockQuestradeTransport();
    const store = new InMemoryRefreshTokenStore("mock-refresh-token-0");
    const manager = new QuestradeTokenManager(
      tokenTransport,
      store,
      () => new Date(),
      0,
    );
    await manager.getSession();
    const failingTransport: QuestradeTransport & TokenTransport = {
      redeemRefreshToken: (token: string) =>
        tokenTransport.redeemRefreshToken(token),
      searchSymbols: (...args) =>
        (tokenTransport as QuestradeTransport).searchSymbols(...args),
      getSymbolDetails: (...args) =>
        (tokenTransport as QuestradeTransport).getSymbolDetails(...args),
      getQuotes: async () => {
        throw new QuestradeHttpError(401, "quotes");
      },
      getCandles: (...args) =>
        (tokenTransport as QuestradeTransport).getCandles(...args),
      getMarkets: (...args) =>
        (tokenTransport as QuestradeTransport).getMarkets(...args),
    };
    const adapter = new QuestradeAdapter(
      manager,
      failingTransport,
      () => new Date(),
      "QUESTRADE_MOCK",
    );
    // Single retry only: the second 401 must surface instead of looping.
    await expect(adapter.getQuotes([1001])).rejects.toMatchObject({
      status: 401,
    });
    expect(tokenTransport.authCallCount).toBe(2);
  });
});
