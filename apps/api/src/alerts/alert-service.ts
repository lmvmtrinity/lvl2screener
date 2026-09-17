import {
  DEFAULT_ALERT_POLICY,
  type AlertPolicy,
  type ScannerAlert,
  type StrategyStateEvent,
} from "@tsx-scanner/contracts";

export function alertDeduplicationKey(
  type: ScannerAlert["type"],
  setupInstanceId: string | null,
  eventId: string,
): string {
  return `${type}:${setupInstanceId ?? eventId}`;
}

export function createAlert(
  event: StrategyStateEvent,
): ScannerAlert | undefined {
  if (event.state === "READY" && event.previousState !== "READY") {
    return {
      alertId: event.eventId,
      eventId: event.eventId,
      type: "READY",
      symbol: event.symbol,
      strategy: event.strategy,
      profileId: event.profileId,
      profileName: event.profileName,
      strategyVersion: event.strategyVersion,
      configVersion: event.configVersion,
      timestamp: event.timestamp,
      previousState: event.previousState,
      state: event.state,
      score: event.score,
      title: `${event.symbol} is READY`,
      message: `${event.strategy.replaceAll("_", " ")} reached READY with score ${event.score}.`,
      reasonCodes: [...event.reasonCodes],
      setupInstanceId: event.setupInstanceId ?? null,
      deduplicationKey: alertDeduplicationKey(
        "READY",
        event.setupInstanceId ?? null,
        event.eventId,
      ),
      entryReference: event.entryReference,
      stopReference: event.stopReference,
      targetReference: event.targetReference,
    };
  }

  if (event.previousState === "READY" && event.state === "INVALIDATED") {
    return {
      alertId: event.eventId,
      eventId: event.eventId,
      type: "INVALIDATION",
      symbol: event.symbol,
      strategy: event.strategy,
      profileId: event.profileId,
      profileName: event.profileName,
      strategyVersion: event.strategyVersion,
      configVersion: event.configVersion,
      timestamp: event.timestamp,
      previousState: event.previousState,
      state: event.state,
      score: event.score,
      title: `${event.symbol} invalidated`,
      message: `${event.strategy.replaceAll("_", " ")} is no longer actionable.`,
      reasonCodes: [...event.reasonCodes],
      setupInstanceId: event.setupInstanceId ?? null,
      deduplicationKey: alertDeduplicationKey(
        "INVALIDATION",
        event.setupInstanceId ?? null,
        event.eventId,
      ),
      entryReference: event.entryReference,
      stopReference: event.stopReference,
      targetReference: event.targetReference,
    };
  }

  return undefined;
}

export function createAlerts(
  events: StrategyStateEvent[],
  recentAlerts: ScannerAlert[] = [],
  policy: AlertPolicy = DEFAULT_ALERT_POLICY,
): ScannerAlert[] {
  const history = [...recentAlerts].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  const created: ScannerAlert[] = [];
  for (const event of [...events].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  )) {
    const alert = createAlert(event);
    if (!alert) continue;
    const deduplicationKey = alert.deduplicationKey!;
    if (
      history.some(
        (value) =>
          (value.deduplicationKey ??
            alertDeduplicationKey(
              value.type,
              value.setupInstanceId,
              value.eventId,
            )) === deduplicationKey,
      )
    )
      continue;
    if (alert.type === "READY") {
      if (
        alert.setupInstanceId &&
        history.some(
          (value) =>
            value.type === "READY" &&
            value.setupInstanceId === alert.setupInstanceId,
        )
      )
        continue;
      const previousReady = history.findLast(
        (value) =>
          value.type === "READY" &&
          value.symbol === alert.symbol &&
          value.profileId === alert.profileId,
      );
      if (previousReady) {
        const elapsedMinutes =
          (Date.parse(alert.timestamp) - Date.parse(previousReady.timestamp)) /
          60_000;
        if (elapsedMinutes < policy.cooldownMinutes) continue;
        if (policy.rearmRule === "AFTER_INVALIDATION") {
          const invalidated = history.some(
            (value) =>
              value.type === "INVALIDATION" &&
              value.symbol === alert.symbol &&
              value.profileId === alert.profileId &&
              Date.parse(value.timestamp) >=
                Date.parse(previousReady.timestamp),
          );
          if (!invalidated) continue;
        }
      }
    } else if (
      alert.setupInstanceId &&
      !history.some(
        (value) =>
          value.type === "READY" &&
          value.setupInstanceId === alert.setupInstanceId,
      )
    ) {
      continue;
    }
    history.push(alert);
    created.push(alert);
  }
  return created;
}
