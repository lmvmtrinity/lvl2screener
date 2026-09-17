import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  mockDevelopmentKey,
  parseMasterKey,
} from "../src/questrade/token-crypto.js";

describe("refresh-token encryption", () => {
  it("round-trips without storing the token in the envelope", () => {
    const key = mockDevelopmentKey();
    const envelope = encryptSecret("sensitive-refresh-token", key);

    expect(envelope).not.toContain("sensitive-refresh-token");
    expect(decryptSecret(envelope, key)).toBe("sensitive-refresh-token");
  });

  it("accepts exact 32-byte keys and rejects weak key material", () => {
    expect(parseMasterKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(
      32,
    );
    expect(() => parseMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(
      "32-byte",
    );
  });

  it("fails closed when ciphertext is read with another key", () => {
    const envelope = encryptSecret("token", Buffer.alloc(32, 1));
    expect(() => decryptSecret(envelope, Buffer.alloc(32, 2))).toThrow(
      "Unable to decrypt",
    );
  });
});
