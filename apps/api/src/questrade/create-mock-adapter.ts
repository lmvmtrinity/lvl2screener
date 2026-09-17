/**
 * @supported (decision-gated, defaulted per private development record W10)
 * Dedicated mock adapter factory used only by ../phase0.ts and this module's own test
 * (apps/api/tests/mock-adapter.test.ts). It is distinct from the MockQuestradeTransport wired
 * into the running API for MARKET_DATA_MODE=mock (see src/index.ts), which is used directly
 * rather than through this factory. Tied to the phase0.ts decision: keep while phase0.ts is a
 * supported smoke/acceptance tool; remove alongside it if the Phase 0 artifact has no operator
 * use. No removal decision was recorded, so the default is keep.
 */
import { QuestradeAdapter } from "./adapter.js";
import { MockQuestradeTransport } from "./mock-transport.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeTokenManager,
} from "./token-manager.js";
import { QuestradeRateLimiter } from "./rate-limiter.js";
import { MockRequestBudget } from "./request-budget.js";

export const PHASE0_NOW = new Date("2026-08-24T14:00:00.000Z");

export function createMockQuestradeAdapter(
  clock: () => Date = () => new Date(PHASE0_NOW),
) {
  const transport = new MockQuestradeTransport();
  const tokenStore = new InMemoryRefreshTokenStore("mock-refresh-token-0");
  const rateLimiter = new QuestradeRateLimiter(
    2,
    2,
    clock,
    new MockRequestBudget(),
  );
  const tokenManager = new QuestradeTokenManager(
    transport,
    tokenStore,
    clock,
    30_000,
    rateLimiter,
  );
  const adapter = new QuestradeAdapter(
    tokenManager,
    transport,
    clock,
    "QUESTRADE_MOCK",
    rateLimiter,
  );

  return { adapter, tokenManager, tokenStore, transport, rateLimiter };
}
