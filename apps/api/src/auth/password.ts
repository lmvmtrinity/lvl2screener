import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** W5: single-operator password hashing for the remote-access profile. Deliberately not a
 * multi-user identity system -- see private development record W5, which
 * scopes this app as single-operator/single-workstation. The stored format is
 * "scrypt:<saltHex>:<hashHex>" so OPERATOR_PASSWORD_HASH is self-describing and never contains
 * the plaintext password. */

const KEY_LENGTH = 64;

export function hashOperatorPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyOperatorPassword(
  password: string,
  storedHash: string,
): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}
