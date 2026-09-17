import {
  challengerScopeSchema,
  type ChallengerScope,
} from "@tsx-scanner/contracts";
import { canonicalJson } from "../backtests/research-coverage.js";

/** Compare the complete immutable economic and input scope. Partial scopes are
 * intentionally not compatible: equality of the fields that happen to be
 * present is not evidence that omitted assumptions match. */
export function sameChallengerScope(
  left: ChallengerScope,
  right: ChallengerScope,
): boolean {
  const a = challengerScopeSchema.safeParse(left);
  const b = challengerScopeSchema.safeParse(right);
  return (
    a.success && b.success && canonicalJson(a.data) === canonicalJson(b.data)
  );
}
