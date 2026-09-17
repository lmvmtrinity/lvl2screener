import type { MarkerLayout } from "../lib/formation-markers.js";

export function FormationMarkers({
  markers,
}: {
  markers: readonly MarkerLayout[];
}) {
  return (
    <g aria-label="Retained formation evidence">
      {markers.map((marker) => {
        const text = `${marker.label}; origin ${marker.originAt ?? "unknown"}; available ${marker.availableAt ?? "unknown"}; recorded ${marker.recordedAt}; event/bar ${marker.plotAt}`;
        return (
          <g key={marker.id} role="img" aria-label={text}>
            <title>{text}</title>
            <circle
              cx={marker.x}
              cy={marker.y}
              r={4}
              fill="#67d6cc"
              stroke="#111827"
            />
          </g>
        );
      })}
    </g>
  );
}
