import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FormationMarkers } from "./FormationMarkers.js";

it("announces exact event time and unknown origin without synthesizing provenance", () => {
  const at = "2026-09-08T14:40:00.000Z";
  const { container } = render(
    <svg>
      <FormationMarkers
        markers={[
          {
            id: "event-a",
            kind: "STATE_EVENT",
            plotAt: at,
            originAt: null,
            availableAt: at,
            recordedAt: at,
            price: null,
            label: "State READY",
            x: 120,
            y: 38,
          },
        ]}
      />
    </svg>,
  );
  expect(
    screen.getByRole("img", { name: /State READY; origin unknown/ }),
  ).toBeTruthy();
  expect(container.querySelector("circle")?.getAttribute("cx")).toBe("120");
  expect(container.querySelector("title")?.textContent).toContain(
    `event/bar ${at}`,
  );
});
