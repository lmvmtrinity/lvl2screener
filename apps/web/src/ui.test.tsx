import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Popover } from "./ui.js";

describe("Popover", () => {
  it("opens its labelled content when the trigger is clicked", () => {
    render(
      <Popover label="Alert settings" trigger={() => "ALERTS"}>
        <p>Configure alerts</p>
      </Popover>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Alert settings" }));

    expect(
      screen.getByRole("dialog", { name: "Alert settings" }),
    ).toHaveTextContent("Configure alerts");
  });
});
