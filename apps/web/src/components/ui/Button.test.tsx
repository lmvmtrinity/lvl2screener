import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to type=button and does not submit an enclosing form", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    render(
      <form onSubmit={onSubmit}>
        <Button>Run preview</Button>
      </form>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run preview" }));

    expect(screen.getByRole("button", { name: "Run preview" })).toHaveAttribute(
      "type",
      "button",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still submits a form when given an explicit submit type", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Working
      </Button>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Working" }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("forwards a ref and preserves the accessible name", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} aria-label="Preview discovery">
        Run
      </Button>,
    );

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(
      screen.getByRole("button", { name: "Preview discovery" }),
    ).toBeInTheDocument();
  });
});
