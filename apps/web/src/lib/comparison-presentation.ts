import type {
  ProfileComparison,
  ProfileComparisonMetric,
} from "@tsx-scanner/contracts";

export function comparisonHeading(
  value: Pick<ProfileComparison, "status">,
): string {
  return value.status === "CONTROLLED"
    ? "Controlled profile comparison"
    : value.status === "UNCONTROLLED"
      ? "Profiles differ in research scope"
      : "Comparison evidence incomplete";
}

export function formatClosedOutcomeDrawdown(
  value: Pick<
    ProfileComparisonMetric,
    "maximumDrawdown" | "drawdownStatus" | "drawdownBasis"
  >,
  currency: "CAD" | "USD",
): string {
  if (value.drawdownStatus === "NO_CLOSED_OUTCOMES") return "No outcomes";
  if (
    value.drawdownStatus !== "AVAILABLE" ||
    value.drawdownBasis !== "REALIZED_CLOSED_OUTCOMES" ||
    value.maximumDrawdown === null
  )
    return "—";
  return `${currency} ${value.maximumDrawdown.toFixed(2)}`;
}
