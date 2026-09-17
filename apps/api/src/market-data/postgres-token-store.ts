import type { Pool, PoolClient } from "pg";
import type { RefreshTokenStore } from "../questrade/token-manager.js";
import { decryptSecret, encryptSecret } from "../questrade/token-crypto.js";

interface AuthRow {
  encrypted_refresh_token: string;
  encrypted_previous_refresh_token: string | null;
  rotation_started_at: Date | null;
}

export class EncryptedPostgresRefreshTokenStore implements RefreshTokenStore {
  private bootstrapToken: string | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
    private readonly provider = "questrade",
  ) {}

  async initialize(initialRefreshToken: string): Promise<void> {
    // Kept as a last-resort candidate. The row already existing means a freshly issued token in
    // the environment would otherwise be ignored, which is the trap an operator hits when
    // recovering: they paste a new token, restart, and nothing changes.
    this.bootstrapToken = initialRefreshToken;
    await this.pool.query(
      `INSERT INTO market_data_auth (provider, encrypted_refresh_token)
       VALUES ($1, $2)
       ON CONFLICT (provider) DO NOTHING`,
      [this.provider, encryptSecret(initialRefreshToken, this.key)],
    );
  }

  async readCandidates(): Promise<string[]> {
    const row = await this.readRow();
    if (!row)
      throw new Error("No persisted Questrade refresh token is available");
    // The current token decrypts strictly, so a wrong master key still reports itself clearly.
    const candidates = [
      decryptSecret(row.encrypted_refresh_token, this.key),
      this.decrypt(row.encrypted_previous_refresh_token),
      this.bootstrapToken,
    ];
    return candidates.filter(
      (value, index, all): value is string =>
        Boolean(value) && all.indexOf(value) === index,
    );
  }

  async beginRotation(): Promise<void> {
    await this.pool.query(
      "UPDATE market_data_auth SET rotation_started_at = NOW() WHERE provider = $1 AND rotation_started_at IS NULL",
      [this.provider],
    );
  }

  async rotate(consumedToken: string, replacementToken: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.readForUpdate(client);
      const known = [
        this.decrypt(current.encrypted_refresh_token),
        this.decrypt(current.encrypted_previous_refresh_token),
        this.bootstrapToken,
      ];
      if (!known.includes(consumedToken)) {
        throw new Error("Refresh token changed during atomic rotation");
      }
      await client.query(
        `UPDATE market_data_auth
         SET encrypted_refresh_token = $2,
             encrypted_previous_refresh_token = $3,
             rotation_started_at = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE provider = $1`,
        [
          this.provider,
          encryptSecret(replacementToken, this.key),
          encryptSecret(consumedToken, this.key),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async interruptedRotationAt(): Promise<Date | undefined> {
    const row = await this.readRow();
    return row?.rotation_started_at ?? undefined;
  }

  private async readRow(): Promise<AuthRow | undefined> {
    const result = await this.pool.query<AuthRow>(
      `SELECT encrypted_refresh_token, encrypted_previous_refresh_token, rotation_started_at
       FROM market_data_auth WHERE provider = $1`,
      [this.provider],
    );
    return result.rows[0];
  }

  private async readForUpdate(client: PoolClient): Promise<AuthRow> {
    const result = await client.query<AuthRow>(
      `SELECT encrypted_refresh_token, encrypted_previous_refresh_token, rotation_started_at
       FROM market_data_auth WHERE provider = $1 FOR UPDATE`,
      [this.provider],
    );
    const row = result.rows[0];
    if (!row)
      throw new Error("No persisted Questrade refresh token is available");
    return row;
  }

  /** A superseded token encrypted under a retired master key must not block the current one. */
  private decrypt(envelope: string | null): string | undefined {
    if (!envelope) return undefined;
    try {
      return decryptSecret(envelope, this.key);
    } catch {
      return undefined;
    }
  }
}
