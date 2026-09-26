import { afterEach, describe, expect, it } from "vitest";
import {
  loadNavOrder,
  moveNavItem,
  normalizeNavOrder,
  saveNavOrder,
} from "./nav-order.js";

const defaults = ["scanner", "discovery", "bot", "backtests"] as const;

describe("nav order", () => {
  afterEach(() => localStorage.clear());

  it("drops unknown or duplicate saved keys and appends new sections", () => {
    expect(
      normalizeNavOrder(["bot", "retired", "bot", 7, "scanner"], defaults),
    ).toEqual(["bot", "scanner", "discovery", "backtests"]);
    expect(normalizeNavOrder({ not: "a list" }, defaults)).toEqual([
      ...defaults,
    ]);
  });

  it("moves an item and clamps the target to the list", () => {
    expect(moveNavItem(defaults, 3, 0)).toEqual([
      "backtests",
      "scanner",
      "discovery",
      "bot",
    ]);
    expect(moveNavItem(defaults, 0, -1)).toEqual([...defaults]);
    expect(moveNavItem(defaults, 2, 99)).toEqual([
      "scanner",
      "discovery",
      "backtests",
      "bot",
    ]);
  });

  it("round-trips a custom order and clears storage for the default", () => {
    saveNavOrder(["backtests", "scanner", "discovery", "bot"], defaults);
    expect(loadNavOrder(defaults)).toEqual([
      "backtests",
      "scanner",
      "discovery",
      "bot",
    ]);
    saveNavOrder(defaults, defaults);
    expect(localStorage.getItem("tsx-scanner-nav-order")).toBeNull();
    localStorage.setItem("tsx-scanner-nav-order", "{broken json");
    expect(loadNavOrder(defaults)).toEqual([...defaults]);
  });
});
