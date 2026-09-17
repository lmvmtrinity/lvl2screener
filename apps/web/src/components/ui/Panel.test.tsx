import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Panel, PanelHeader } from "./Panel.js";

afterEach(cleanup);

describe("Panel", () => {
  it("renders the caller-selected element and heading level", () => {
    render(
      <Panel as="article" aria-label="Example panel">
        <PanelHeader
          level={2}
          title="Heading"
          description="Supporting detail"
          actions={<span>Trailing action</span>}
        />
        <div>Body</div>
      </Panel>,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Heading" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Supporting detail")).toBeInTheDocument();
    expect(screen.getByText("Trailing action")).toBeInTheDocument();
    expect(screen.getByLabelText("Example panel").tagName).toBe("ARTICLE");
  });

  it("keeps the heading as the panel's accessible name source when titled", () => {
    render(
      <Panel>
        <PanelHeader title="Symbol catalog" />
      </Panel>,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "Symbol catalog" }),
    ).toBeInTheDocument();
  });
});
