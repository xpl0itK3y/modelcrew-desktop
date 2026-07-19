import { describe, expect, it } from "vitest";
import { graphEdgePath } from "./graphGeometry";

describe("graphEdgePath", () => {
  it("keeps a lane vertical", () => {
    expect(graphEdgePath(5.5, 0, 5.5, 11, "top")).toBe("M5.5 0V11");
    expect(graphEdgePath(5.5, 11, 5.5, 22, "bottom")).toBe(
      "M5.5 11V22",
    );
  });

  it("enters a node with a vertical, rounded and horizontal segment", () => {
    expect(graphEdgePath(5.5, 0, 16.5, 11, "top")).toBe(
      "M5.5 0V6Q5.5 11 10.5 11H16.5",
    );
  });

  it("leaves a node horizontally and turns down into the target lane", () => {
    expect(graphEdgePath(5.5, 11, 16.5, 22, "bottom")).toBe(
      "M5.5 11H11.5Q16.5 11 16.5 16V22",
    );
    expect(graphEdgePath(16.5, 11, 5.5, 22, "bottom")).toBe(
      "M16.5 11H10.5Q5.5 11 5.5 16V22",
    );
  });

  it("clamps the corner to a short transition", () => {
    expect(graphEdgePath(0, 0, 3, 4, "top")).toBe(
      "M0 0V1Q0 4 3 4H3",
    );
  });
});
