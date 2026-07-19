import { describe, expect, it } from "vitest";
import {
  graphIncomingPath,
  graphLaneCenter,
  graphParentPath,
  graphThroughPath,
} from "./graphGeometry";

describe("VS Code-compatible graph geometry", () => {
  it("places the first swimlane at x=11", () => {
    expect(graphLaneCenter(0)).toBe(11);
    expect(graphLaneCenter(2)).toBe(33);
  });

  it("draws a stable swimlane vertically", () => {
    expect(graphThroughPath(0, 0)).toBe("M 11 0 V 22");
  });

  it("uses two radius-5 arcs when a collapsed lane shifts left", () => {
    expect(graphThroughPath(2, 0)).toBe(
      "M 33 0 V 6 A 5 5 0 0 1 28 11 H 16 A 5 5 0 0 0 11 16 V 22",
    );
  });

  it("supports the mirrored transition for partial histories", () => {
    expect(graphThroughPath(0, 2)).toBe(
      "M 11 0 V 6 A 5 5 0 0 0 16 11 H 28 A 5 5 0 0 1 33 16 V 22",
    );
  });

  it("draws the primary and duplicate inputs to a commit", () => {
    expect(graphIncomingPath(0, 0)).toBe("M 11 0 V 11");
    expect(graphIncomingPath(2, 0)).toBe(
      "M 33 0 A 11 11 0 0 1 22 11 H 11",
    );
  });

  it("draws first and additional parent connections", () => {
    expect(graphParentPath(0, 0, 0)).toBe("M 11 11 V 22");
    expect(graphParentPath(0, 2, 1)).toBe(
      "M 22 11 A 11 11 0 0 1 33 22 M 22 11 H 11",
    );
  });
});
