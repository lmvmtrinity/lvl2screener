import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tip } from "../../ui.js";
import { FieldSelect, FormField } from "./FormField.js";

afterEach(cleanup);

describe("FormField", () => {
  it("forwards native label props so Tip tooltips open on keyboard focus", async () => {
    render(
      <Tip label="Focus help">
        <FormField label="STATE">
          <FieldSelect aria-label="State">
            <option value="ALL">ALL STATES</option>
          </FieldSelect>
        </FormField>
      </Tip>,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    screen.getByRole("combobox", { name: "State" }).focus();

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Focus help");
  });

  it("keeps a caller-supplied className alongside the field layout", () => {
    render(<FormField label="STATE" className="tw:mt-2" data-testid="field" />);

    const field = screen.getByTestId("field");

    expect(field).toHaveClass("tw:mt-2");
    expect(field).toHaveClass("tw:flex-col");
  });
});
