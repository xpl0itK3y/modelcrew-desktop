import { describe, expect, it } from "vitest";
import { gridDimensions } from "./layoutOps";

describe("gridDimensions", () => {
  it("builds near-square grids with columns favoured over rows", () => {
    expect(gridDimensions(1)).toEqual({ rows: 1, cols: 1 });
    expect(gridDimensions(2)).toEqual({ rows: 1, cols: 2 });
    expect(gridDimensions(3)).toEqual({ rows: 2, cols: 2 });
    expect(gridDimensions(4)).toEqual({ rows: 2, cols: 2 });
    expect(gridDimensions(5)).toEqual({ rows: 2, cols: 3 });
    expect(gridDimensions(6)).toEqual({ rows: 2, cols: 3 });
    expect(gridDimensions(7)).toEqual({ rows: 3, cols: 3 });
    expect(gridDimensions(9)).toEqual({ rows: 3, cols: 3 });
    expect(gridDimensions(12)).toEqual({ rows: 3, cols: 4 });
  });
});
