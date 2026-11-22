import { describe, expect, it } from "vitest";
import {
  apportion,
  areas,
  COLS,
  layout,
  links,
  outline,
  ROWS,
  textBlock,
} from "../src/cutboard.ts";

const CELLS = COLS * ROWS;

describe("apportion", () => {
  it("splits exactly when it can", () => {
    expect(apportion([1, 2], 24, 5)).toEqual([8, 16]);
    expect(apportion([1, 1, 1], 24, 5)).toEqual([8, 8, 8]);
  });

  it("lifts a part below the minimum from the largest", () => {
    expect(apportion([1, 10], 12, 3)).toEqual([3, 9]);
  });
});

describe("layout", () => {
  it("gives two tasks with one agent each half of the sheet", () => {
    const grid = layout([1, 1]);
    expect(areas(grid, 2)).toEqual([CELLS / 2, CELLS / 2]);
  });

  it("gives a task with two agents two thirds next to one with one agent", () => {
    const grid = layout([2, 1]);
    expect(areas(grid, 2)).toEqual([(CELLS * 2) / 3, CELLS / 3]);
  });

  it("keeps areas proportional for more tasks", () => {
    expect(areas(layout([1, 1, 1]), 3)).toEqual([96, 96, 96]);
    expect(areas(layout([1, 1, 1, 1]), 4)).toEqual([72, 72, 72, 72]);
    const mixed = areas(layout([3, 2, 1, 1, 1]), 5);
    expect(mixed.reduce((a, b) => a + b, 0)).toBe(CELLS);
    // Within a few cells of 3:2:1:1:1 of 288 (108, 72, 36, 36, 36).
    [108, 72, 36, 36, 36].forEach((want, i) => {
      expect(Math.abs((mixed[i] as number) - want)).toBeLessThanOrEqual(12);
    });
  });

  it("makes neighbours interlock: pieces are not plain rectangles", () => {
    const grid = layout([1, 1]);
    expect(outline(grid, 0).length).toBeGreaterThan(4);
    expect(outline(grid, 1).length).toBeGreaterThan(4);
  });

  it("keeps every piece whole and with room for its text", () => {
    for (const weights of [[1], [1, 1], [2, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1]]) {
      const grid = layout(weights);
      weights.forEach((_, id) => {
        const t = textBlock(grid, id);
        expect(t).not.toBeNull();
        expect((t?.c1 ?? 0) - (t?.c0 ?? 0)).toBeGreaterThanOrEqual(4);
        expect((t?.r1 ?? 0) - (t?.r0 ?? 0)).toBeGreaterThanOrEqual(3);
      });
    }
  });

  it("is empty without pieces", () => {
    expect(layout([])).toEqual([]);
  });
});

describe("links", () => {
  it("runs an arrow from inside one piece into the other", () => {
    const grid = layout([1, 1]);
    const [link] = links(grid, [[0, 1]]);
    expect(link).not.toBeNull();
    const cell = (p: [number, number]) => grid[Math.floor(p[1])]?.[Math.floor(p[0])];
    expect(cell(link?.from as [number, number])).toBe(0);
    expect(cell(link?.to as [number, number])).toBe(1);
    // Long enough to carry a label: more than the two cells that touch.
    const length =
      Math.abs((link?.to[0] ?? 0) - (link?.from[0] ?? 0)) +
      Math.abs((link?.to[1] ?? 0) - (link?.from[1] ?? 0));
    expect(length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a second arrow between the same pieces clear of the first", () => {
    const grid = layout([1, 1]);
    const [there, back] = links(grid, [
      [0, 1],
      [1, 0],
    ]);
    const mid = (l: typeof there) => [
      ((l?.from[0] ?? 0) + (l?.to[0] ?? 0)) / 2,
      ((l?.from[1] ?? 0) + (l?.to[1] ?? 0)) / 2,
    ];
    const [a, b] = [mid(there), mid(back)];
    expect(Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0))).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("links pieces that do not touch, and nothing to itself or to a missing piece", () => {
    const grid = layout([1, 1, 1]);
    const [far, self, missing] = links(grid, [
      [0, 2],
      [1, 1],
      [0, -1],
    ]);
    expect(far).not.toBeNull();
    expect(self).toBeNull();
    expect(missing).toBeNull();
  });
});
