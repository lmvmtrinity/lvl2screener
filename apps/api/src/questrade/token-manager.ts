import type { AuthSession, RawTokenGrant, TokenTransport } from "./types.js";
import type { QuestradeRequestScheduler } from "./rate-limiter.js";

export interface RefreshTokenStore {
  /** Every token worth trying, newest first. The older entries exist so a rotation that was
   *  interrupted, or a redeem that failed after Questrade had already answered, is recoverable. */
  readCandidates(): Promise<string[]>;
  /** Durably records that a redeem is about to consume the current token. A process that dies
   *  after this point but before `rotate` leaves the marker set, which is how the next boot knows
   *  the stored token was probably consumed rather than merely rejected. */
  beginRotation(): Promise<void>;
  /** Atomically installs `replacementToken`, keeping `consumedToken` as a fallback candidate. */
  rotate(consumedToken: string, replacementToken: string): Promise<void>;
  /** When a previous process died mid-rotation, the time it started. */
  interruptedRotationAt(): Promise<Date | undefined>;
}

export class QuestradeAuthenticationError extends Error {
  constructor(
    cause: unknown,
    message = "Unable to refresh Questrade authentication",
  ) {
    super(message, { cause });
    this.name = "QuestradeAuthenticationError";
  }
}

/** Every stored credential was rejected. Only a new manual authorization can clear this. */
export class QuestradeReauthorizationRequiredError extends QuestradeAuthenticationError {
  constructor(
    cause: unknown,
    readonly interruptedAt?: Date,
  ) {
    super(
      cause,
      interruptedAt
        ? `Questrade rejected every stored refresh token. A rotation started at ${interruptedAt.toISOString()} never completed, so the stored token was most likely consumed. A new manual authorization token is required.`
        : "Questrade rejected every stored refresh token. A new manual authorization token is required.",
    );
    this.name = "QuestradeReauthorizationRequiredError";
  }
}

/** A redeem attempt failed for a reason that says nothing about whether the token itself is
 *  valid — a timeout, HTTP 429, or a 5xx. The current (still-unconsumed) candidate should be
 *  retried with backoff; this must never fall back to older tokens or ask for manual
 *  reauthorization, since the credential was never actually rejected. */
export class QuestradeTransientTokenError extends QuestradeAuthenticationError {
  constructor(cause: unknown) {
    super(
      cause,
      "Questrade token redemption failed transiently (timeout/429/5xx) and should be retried without treating the credential as invalid",
    );
    this.name = "QuestradeTransientTokenError";
  }
}

/** Questrade issued a replacement token, but durably committing it (the store's `rotate` call)
 *  failed. Credential state is now uncertain: Questrade may have already invalidated the
 *  presented token server-side. This is neither "retry the same request" nor "reauthorize
 *  manually" — it needs its own recovery handling by the caller. */
export class QuestradeTokenPersistenceUncertainError extends QuestradeAuthenticationError {
  constructor(cause: unknown) {
    super(
      cause,
      "Questrade issued a replacement token but persisting it durably failed; credential state is uncertain and requires recovery",
    );
    this.name = "QuestradeTokenPersistenceUncertainError";
  }
}

/** Duck-types the failure rather than importing `QuestradeHttpError` from the live transport, so
 *  this module has no dependency on any particular `TokenTransport` implementation. */
function isTransientRedemptionFailure(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number" && (status === 429 || status >= 500))
      return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && /timeout/i.test(error.name + error.message))
    return true;
  return false;
}

export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private previousToken: string | undefined;
  private rotationStartedAt: Date | undefined;

  constructor(private refreshToken: string) {}

  async readCandidates(): Promise<string[]> {
    return [this.refreshToken, this.previousToken].filter(
      (value): value is string => Boolean(value),
    );
  }

  async beginRotation(): Promise<void> {
    this.rotationStartedAt = new Date();
  }

  async rotate(consumedToken: string, replacementToken: string): Promise<void> {
    if (
      consumedToken !== this.refreshToken &&
      consumedToken !== this.previousToken
    ) {
      throw new Error("Refresh token changed during rotation");
    }

    this.previousToken = consumedToken;
    this.refreshToken = replacementToken;
    this.rotationStartedAt = undefined;
  }

  async interruptedRotationAt(): Promise<Date | undefined> {
    return this.rotationStartedAt;
  }

  /** Test helper: the token a fresh redeem would use. */
  async read(): Promise<string> {
    return this.refreshToken;
  }
}

export class QuestradeTokenManager {
  private session: AuthSession | undefined;
  private refreshInFlight: Promise<AuthSession> | undefined;
  /** Read once, before this process marks any rotation of its own, so the marker is only ever
   *  reported as evidence when it was left behind by an earlier process. */
  private priorInterruption: Date | undefined;
  private priorInterruptionRead = false;

  constructor(
    private readonly transport: TokenTransport,
    private readonly store: RefreshTokenStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly expirySkewMs = 30_000,
    private readonly scheduler?: QuestradeRequestScheduler,
  ) {}

  async getSession(): Promise<AuthSession> {
    if (
      this.session &&
      this.session.expiresAt.getTime() - this.expirySkewMs >
        this.clock().getTime()
    ) {
      return this.session;
    }

    return this.refresh();
  }

  async refresh(): Promise<AuthSession> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.rotateSession().finally(() => {
      this.refreshInFlight = undefined;
    });

    return this.refreshInFlight;
  }

  /** Resolves once no rotation is in flight. Shutdown awaits this: killing the process between
   *  Questrade issuing a replacement token and the store committing it strands the account. */
  async settle(): Promise<void> {
    await this.refreshInFlight?.catch(() => undefined);
  }

  private async rotateSession(): Promise<AuthSession> {
    if (!this.priorInterruptionRead) {
      this.priorInterruption = await this.store.interruptedRotationAt();
      this.priorInterruptionRead = true;
    }

    const candidates = await this.store.readCandidates();
    if (candidates.length === 0) {
      throw new QuestradeReauthorizationRequiredError(
        new Error("No persisted Questrade refresh token is available"),
      );
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return await this.redeem(candidate);
      } catch (error) {
        // Transient failures and post-redemption persistence failures say nothing about whether
        // the credential itself is valid, so they must never fall back to an older, already
        // superseded token or be reported as requiring manual reauthorization.
        if (
          error instanceof QuestradeTransientTokenError ||
          error instanceof QuestradeTokenPersistenceUncertainError
        ) {
          throw error;
        }
        // Every remaining candidate is already superseded, so falling back costs nothing once the
        // failure is an explicit rejection (invalid grant) rather than an ambiguous one.
        lastError = error;
      }
    }

    throw new QuestradeReauthorizationRequiredError(
      lastError,
      this.priorInterruption,
    );
  }

  private async redeem(refreshToken: string): Promise<AuthSession> {
    await this.store.beginRotation();
    let grant: RawTokenGrant;
    try {
      grant = this.scheduler
        ? await this.scheduler.schedule("P0", () =>
            this.transport.redeemRefreshToken(refreshToken),
          )
        : await this.transport.redeemRefreshToken(refreshToken);
    } catch (error) {
      if (isTransientRedemptionFailure(error))
        throw new QuestradeTransientTokenError(error);
      throw error;
    }
    const nextSession = this.toSession(grant);

    // The compare-and-swap style store contract makes concurrent or stale rotation fail loudly.
    // Questrade has already consumed `refreshToken` and issued `nextSession` by this point, so a
    // failure here means credential state is uncertain rather than that the redeem failed.
    try {
      await this.store.rotate(refreshToken, nextSession.refreshToken);
    } catch (error) {
      throw new QuestradeTokenPersistenceUncertainError(error);
    }
    this.session = nextSession;
    return nextSession;
  }

  private toSession(grant: RawTokenGrant): AuthSession {
    if (
      grant.token_type !== "Bearer" ||
      grant.expires_in <= 0 ||
      !grant.access_token ||
      !grant.refresh_token
    ) {
      throw new Error("Questrade returned an invalid token grant");
    }

    const apiServer = new URL(grant.api_server);
    if (apiServer.protocol !== "https:") {
      throw new Error("Questrade API server must use HTTPS");
    }

    return {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt: new Date(this.clock().getTime() + grant.expires_in * 1_000),
      apiServer,
    };
  }
}
