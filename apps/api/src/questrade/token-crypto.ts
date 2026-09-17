import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = /^[a-f\d]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      "APP_MASTER_KEY must be a 32-byte base64 value or 64-character hex value",
    );
  }
  return decoded;
}

export function mockDevelopmentKey(): Buffer {
  return createHash("sha256").update("tsx-scanner:mock-only:phase-2").digest();
}

export function encryptSecret(secret: string, key: Buffer): string {
  if (!secret) throw new Error("Cannot encrypt an empty secret");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(envelope: string, key: Buffer): string {
  const [version, ivValue, tagValue, ciphertextValue] = envelope.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Invalid encrypted secret envelope");
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt persisted credential");
  }
}
