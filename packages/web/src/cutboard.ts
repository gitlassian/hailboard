/**
 * The board as one cut sheet: every task gets a piece of a 24×12 grid whose area is proportional
 * to its weight (the number of agents on it: one and one share the sheet 50/50, one and two
 * 33/67), and the pieces interlock with steps where they meet. The steps trade cells evenly, so
 * they never change an area. Pure functions, so the layout can be tested without a browser.
 */

export const COLS = 24;
export const ROWS = 12;
/** At most this many pieces fit on the sheet (three rows each, four columns). */
export const MAX_PIECES = 16;
/** The smallest text block a piece keeps, in cells. */
const MIN_TEXT_COLS = 4;
const MIN_TEXT_ROWS = 3;

/** Which piece every cell belongs to: grid[row][col] is an index into the weights. */
export type Grid = number[][];

/**
 * Splits `total` into whole parts proportional to `weights` (largest remainder), then lifts any
 * part below `min` by taking from the largest ones. The proportion is exact whenever it can be.
 */
export function apportion(weights: number[], total: number, min: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0) || n;
  const exact = weights.map((w) => ((w || 1) / sum) * total);
  const out = exact.map((e) => Math.floor(e));
  const order = exact
    .map((e, i) => ({ i, rest: e - Math.floor(e) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) {
    const i = (order[k] as { i: number }).i;
    out[i] = (out[i] as number) + 1;
  }
  const floor = Math.min(min, Math.floor(total / n));
  for (;;) {
    const small = out.findIndex((v) => v < floor);
    if (small < 0) break;
    let big = 0;
    for (let i = 1; i < n; i++) if ((out[i] as number) > (out[big] as number)) big = i;
    if ((out[big] as number) <= floor) break;
    out[big] = (out[big] as number) - 1;
    out[small] = (out[small] as number) + 1;
  }
  return out;
}

/** The cells of piece `id`, as [col, row]. */
function cellsOf(grid: Grid, id: number): [number, number][] {
  const out: [number, number][] = [];
  grid.forEach((row, r) => {
    row.forEach((v, c) => {
      if (v === id) out.push([c, r]);
    });
  });
  return out;
}

function connected(grid: Grid, id: number): boolean {
  const cells = cellsOf(grid, id);
  if (cells.length === 0) return false;
  const seen = new Set<string>();
  const stack = [cells[0] as [number, number]];
  while (stack.length) {
    const [c, r] = stack.pop() as [number, number];
    const key = `${c},${r}`;
    if (seen.has(key) || grid[r]?.[c] !== id) continue;
    seen.add(key);
    stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
  }
  return seen.size === cells.length;
}

export interface Block {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  size: number;
}

/** Text reads best in a block about this big; cells beyond it add nothing. */
const TEXT_COLS = 9;
const TEXT_ROWS = 6;

/**
 * The rectangle of whole cells inside a piece where its text goes: the one that comes closest to
 * a comfortable block of text (a wide, low one beats a narrow, tall one), then the larger one,
 * then the one further up and left.
 */
export function textBlock(grid: Grid, id: number): Block | null {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const fit = (b: Block) => Math.min(b.c1 - b.c0, TEXT_COLS) * Math.min(b.r1 - b.r0, TEXT_ROWS);
  let best: Block | null = null;
  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      if (grid[r0]?.[c0] !== id) continue;
      let maxC = cols;
      for (let r1 = r0; r1 < rows && grid[r1]?.[c0] === id; r1++) {
        let c1 = c0;
        while (c1 < maxC && grid[r1]?.[c1] === id) c1++;
        maxC = c1;
        const block = { size: (maxC - c0) * (r1 - r0 + 1), c0, r0, c1: maxC, r1: r1 + 1 };
        if (
          !best ||
          fit(block) > fit(best) ||
          (fit(block) === fit(best) && block.size > best.size)
        ) {
          best = block;
        }
      }
    }
  }
  return best;
}

/** Every piece is still in one part and keeps room for its text. */
function sound(grid: Grid, n: number): boolean {
  for (let id = 0; id < n; id++) {
    if (!connected(grid, id)) return false;
    const t = textBlock(grid, id);
    if (!t || t.c1 - t.c0 < MIN_TEXT_COLS || t.r1 - t.r0 < MIN_TEXT_ROWS) return false;
  }
  return true;
}

/** How many cells every piece has. */
export function areas(grid: Grid, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const row of grid) for (const v of row) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Applies a change to a copy of the grid and keeps it only when every piece stays sound and
 * keeps its area. */
function attempt(grid: Grid, n: number, change: (g: Grid) => boolean): Grid {
  const next = grid.map((row) => [...row]);
  if (!change(next)) return grid;
  const before = areas(grid, n);
  const after = areas(next, n);
  if (after.some((a, i) => a !== before[i])) return grid;
  return sound(next, n) ? next : grid;
}

/** Sets a cell when it still belongs to `from`; false when it does not (the change is dropped). */
function take(g: Grid, c: number, r: number, from: number, to: number): boolean {
  const row = g[r];
  if (!row || row[c] !== from) return false;
  row[c] = to;
  return true;
}

/**
 * Lays out pieces of the given weights, heavier first, with areas proportional to the weights,
 * then makes neighbours interlock: halfway along the line between two pieces it steps, so each
 * side gives the other as many cells as it takes.
 */
export function layout(weights: number[]): Grid {
  const n = Math.min(weights.length, MAX_PIECES);
  if (n === 0) return [];
  const w = weights.slice(0, n).map((x) => Math.max(1, x));

  // Columns of up to four pieces, filled so that their weights stay even.
  const k = n <= 3 ? n : Math.min(4, Math.ceil(n / 2));
  const perColumn = Math.ceil(n / k);
  const columns: number[][] = Array.from({ length: k }, () => []);
  const load = new Array<number>(k).fill(0);
  for (let id = 0; id < n; id++) {
    let pick = -1;
    for (let c = 0; c < k; c++) {
      if ((columns[c] as number[]).length >= perColumn) continue;
      if (pick < 0 || (load[c] as number) < (load[pick] as number)) pick = c;
    }
    (columns[pick] as number[]).push(id);
    load[pick] = (load[pick] as number) + (w[id] as number);
  }

  const widths = apportion(load, COLS, MIN_TEXT_COLS + 1);
  let grid: Grid = Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(0));
  const spans: { x0: number; x1: number; rows: { id: number; y0: number; y1: number }[] }[] = [];
  let x = 0;
  columns.forEach((ids, c) => {
    const width = widths[c] as number;
    const heights = apportion(
      ids.map((id) => w[id] as number),
      ROWS,
      MIN_TEXT_ROWS,
    );
    let y = 0;
    const rows: { id: number; y0: number; y1: number }[] = [];
    ids.forEach((id, i) => {
      const h = heights[i] as number;
      for (let r = y; r < y + h; r++) {
        const row = grid[r] as number[];
        for (let cc = x; cc < x + width; cc++) row[cc] = id;
      }
      rows.push({ id, y0: y, y1: y + h });
      y += h;
    });
    spans.push({ x0: x, x1: x + width, rows });
    x += width;
  });

  let turn = 0;
  // Steps inside a column, between a piece and the one below it.
  for (const span of spans) {
    span.rows.slice(1).forEach((below, i) => {
      const above = span.rows[i] as { id: number };
      const width = span.x1 - span.x0;
      const half = Math.floor(width / 2);
      if (half < 2) return;
      const flip = turn++ % 2 === 1;
      grid = attempt(grid, n, (g) => {
        let ok = true;
        for (let s = 0; s < half; s++) {
          const left = span.x0 + s;
          const right = span.x1 - 1 - s;
          // One half of the line moves down a row, the other half up a row.
          const [down, up] = flip ? [right, left] : [left, right];
          ok = take(g, down, below.y0, below.id, above.id) && ok;
          ok = take(g, up, below.y0 - 1, above.id, below.id) && ok;
        }
        return ok;
      });
    });
  }

  // Steps between columns, for every pair of pieces that meet across the line.
  for (let c = 1; c < spans.length; c++) {
    const at = (spans[c] as { x0: number }).x0;
    const left = spans[c - 1] as (typeof spans)[number];
    const right = spans[c] as (typeof spans)[number];
    for (const a of left.rows) {
      for (const b of right.rows) {
        const r0 = Math.max(a.y0, b.y0);
        const r1 = Math.min(a.y1, b.y1);
        const half = Math.floor((r1 - r0) / 2);
        if (half < 2) continue;
        const flip = turn++ % 2 === 1;
        for (const d of [2, 1]) {
          const before = grid;
          grid = attempt(grid, n, (g) => {
            let ok = true;
            for (let s = 0; s < half; s++) {
              const top = r0 + s;
              const bottom = r1 - 1 - s;
              // One half of the line moves right, the other half left.
              const [toLeft, toRight] = flip ? [bottom, top] : [top, bottom];
              for (let e = 0; e < d; e++) {
                ok = take(g, at + e, toLeft, b.id, a.id) && ok;
                ok = take(g, at - 1 - e, toRight, a.id, b.id) && ok;
              }
            }
            return ok;
          });
          if (grid !== before) break;
        }
      }
    }
  }
  return grid;
}

type Point = [number, number];

/** The outline of a piece's cells, clockwise, as grid corners. */
export function outline(grid: Grid, id: number): Point[] {
  const next = new Map<string, Point>();
  const owns = (c: number, r: number) => grid[r]?.[c] === id;
  const edge = (x1: number, y1: number, x2: number, y2: number) =>
    next.set(`${x1},${y1}`, [x2, y2]);
  grid.forEach((row, r) => {
    row.forEach((_, c) => {
      if (!owns(c, r)) return;
      if (!owns(c, r - 1)) edge(c, r, c + 1, r);
      if (!owns(c + 1, r)) edge(c + 1, r, c + 1, r + 1);
      if (!owns(c, r + 1)) edge(c + 1, r + 1, c, r + 1);
      if (!owns(c - 1, r)) edge(c, r + 1, c, r);
    });
  });
  const start = next.keys().next().value;
  if (start === undefined) return [];
  const points: Point[] = [];
  for (let at = start; ; ) {
    const [px, py] = at.split(",").map(Number) as Point;
    points.push([px, py]);
    at = (next.get(at) as Point).join(",");
    if (at === start || points.length > 4 * COLS * ROWS) break;
  }
  // Keep only the corners.
  return points.filter((p, i) => {
    const a = points[(i + points.length - 1) % points.length] as Point;
    const b = points[(i + 1) % points.length] as Point;
    return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
  });
}

/** Moves every side of a clockwise right-angled outline inward by d. */
export function shrink(poly: Point[], d: number): Point[] {
  const inward = (a: Point, b: Point): Point => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  };
  return poly.map((v, i) => {
    const n1 = inward(poly[(i + poly.length - 1) % poly.length] as Point, v);
    const n2 = inward(v, poly[(i + 1) % poly.length] as Point);
    return [v[0] + (n1[0] + n2[0]) * d, v[1] + (n1[1] + n2[1]) * d];
  });
}

/** An SVG path for the outline with rounded corners; inner corners round wider to leave the gap. */
export function rounded(poly: Point[], r: number, gap: number): string {
  let d = "";
  poly.forEach((v, i) => {
    const p = poly[(i + poly.length - 1) % poly.length] as Point;
    const n = poly[(i + 1) % poly.length] as Point;
    // The outline runs clockwise: a right turn is an outer corner, a left turn an inner one.
    const outer = (v[0] - p[0]) * (n[1] - v[1]) - (v[1] - p[1]) * (n[0] - v[0]) > 0;
    const want = outer ? r : r + gap * 2;
    const lenP = Math.hypot(p[0] - v[0], p[1] - v[1]) || 1;
    const lenN = Math.hypot(n[0] - v[0], n[1] - v[1]) || 1;
    const rad = Math.min(want, lenP / 2, lenN / 2);
    const a = [v[0] + ((p[0] - v[0]) / lenP) * rad, v[1] + ((p[1] - v[1]) / lenP) * rad];
    const c = [v[0] + ((n[0] - v[0]) / lenN) * rad, v[1] + ((n[1] - v[1]) / lenN) * rad];
    d += `${i ? "L" : "M"}${a[0]?.toFixed(1)} ${a[1]?.toFixed(1)}A${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 ${outer ? 1 : 0} ${c[0]?.toFixed(1)} ${c[1]?.toFixed(1)}`;
  });
  return `${d}Z`;
}

/** An arrow between two pieces, in grid units (cell centres). */
export interface Link {
  from: Point;
  to: Point;
  /** The cells of the two pieces that face each other; the ends may be pulled in as far as these. */
  near: [Point, Point];
}

/** How many cells further apart than the closest place an arrow may be drawn. */
const SLACK = 3;

/** How much an arrow end at this cell would get in the way of the piece's text. */
function clutter(block: Block | null, c: number, r: number): number {
  if (!block || c < block.c0 || c >= block.c1 || r < block.r0 || r >= block.r1) return 0;
  const rx = (c + 0.5 - block.c0) / (block.c1 - block.c0);
  const ry = (r + 0.5 - block.r0) / (block.r1 - block.r0);
  // The title, state and latest message fill the upper left; the pictures the lower left.
  if (ry < 0.6 && rx < 0.75) return 2;
  if (ry > 0.8 && rx < 0.7) return 2;
  return 0.5;
}

function bestLink(grid: Grid, a: number, b: number, taken: Point[]): Link | null {
  if (a === b) return null;
  const cellsA = cellsOf(grid, a);
  const cellsB = cellsOf(grid, b);
  if (cellsA.length === 0 || cellsB.length === 0) return null;
  const blockA = textBlock(grid, a);
  const blockB = textBlock(grid, b);

  let nearest = Number.POSITIVE_INFINITY;
  for (const [ax, ay] of cellsA) {
    for (const [bx, by] of cellsB) {
      const d = Math.abs(ax - bx) + Math.abs(ay - by);
      if (d < nearest) nearest = d;
    }
  }

  let best: Link | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const [ax, ay] of cellsA) {
    for (const [bx, by] of cellsB) {
      // A place a little further apart is fine when it covers less text.
      const apart = Math.abs(ax - bx) + Math.abs(ay - by) - nearest;
      if (apart > SLACK) continue;
      // The arrow runs along the axis on which the two cells are apart, and reaches up to two
      // cells into each piece so that it is long enough to carry a label.
      const across = Math.abs(bx - ax) >= Math.abs(by - ay);
      const sx = across ? Math.sign(bx - ax) : 0;
      const sy = across ? 0 : Math.sign(by - ay);
      let [fx, fy] = [ax, ay];
      for (let i = 0; i < 2 && grid[fy - sy]?.[fx - sx] === a; i++) [fx, fy] = [fx - sx, fy - sy];
      let [tx, ty] = [bx, by];
      for (let i = 0; i < 2 && grid[ty + sy]?.[tx + sx] === b; i++) [tx, ty] = [tx + sx, ty + sy];
      const mid: Point = [(fx + tx) / 2 + 0.5, (fy + ty) / 2 + 0.5];
      const crowd = taken.some((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1]) < 3) ? 4 : 0;
      const short = 4 - (Math.abs(tx - fx) + Math.abs(ty - fy)) * 0.5;
      const cost =
        clutter(blockA, fx, fy) +
        clutter(blockA, ax, ay) * 0.5 +
        clutter(blockB, tx, ty) +
        clutter(blockB, bx, by) * 0.5 +
        crowd +
        short +
        apart * 0.6 -
        // Of equally good places, the one further right and down.
        (ax + ay + bx + by) * 0.001;
      if (cost < bestCost) {
        bestCost = cost;
        best = {
          from: [fx + 0.5, fy + 0.5],
          to: [tx + 0.5, ty + 0.5],
          near: [
            [ax + 0.5, ay + 0.5],
            [bx + 0.5, by + 0.5],
          ],
        };
      }
    }
  }
  return best;
}

/**
 * Where arrows between pairs of pieces run. Each starts inside the first piece and ends inside
 * the second, next to where the two are closest, at the place that covers the least text; arrows
 * placed earlier are kept clear of. Null for a pair that cannot be linked.
 */
export function links(grid: Grid, pairs: [number, number][]): (Link | null)[] {
  const taken: Point[] = [];
  return pairs.map(([a, b]) => {
    const link = bestLink(grid, a, b, taken);
    if (link) taken.push([(link.from[0] + link.to[0]) / 2, (link.from[1] + link.to[1]) / 2]);
    return link;
  });
}
