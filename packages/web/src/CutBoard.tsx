import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  COLS,
  type Link,
  layout,
  links,
  outline,
  ROWS,
  rounded,
  shrink,
  textBlock,
} from "./cutboard.ts";
import { Picture } from "./pictures/Picture.tsx";

const GAP = 4;
// A piece sits in the card's padding, so its corner is the card's less that padding (--r-1 in
// styles.css): 24 - 12 - 1. The pattern inside is 4 further in, so its corner is 4 less again.
const RADIUS = 11;
const INSET = 4;
const PAD = 12;

export type Tone = "ok" | "wait" | "ask" | "";

/** One piece of the sheet: a part of the project, or for now an agent. */
export interface Piece {
  key: string;
  /** Person colour class, "p0"…"p5". */
  colour: string;
  /** A piece nobody works on now: drawn as a dashed outline without a pattern. */
  free: boolean;
  /** Bigger numbers get more room. */
  weight: number;
  title: ReactNode;
  chip: { label: string; tone: Tone } | null;
  doing: ReactNode | null;
  desc: ReactNode | null;
  /** Who is on it, for the pictures at the bottom. */
  who: { handle: string; offline: boolean }[];
  /** When somebody last worked on it: "now", "5m". */
  when: string;
  onClick?: (() => void) | undefined;
}

/** A conversation between two pieces, drawn as an arrow from the one who asks. */
export interface Talk {
  from: string;
  to: string;
  label: string;
  state: "asking" | "answered";
}

type Point = [number, number];

/** One pattern per piece, in the piece's colour, fitted so that the tiles start and end whole. */
function Pattern({
  id,
  kind,
  poly,
  colour,
}: {
  id: string;
  kind: number;
  poly: Point[];
  colour: string;
}) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const W = Math.max(...xs) - x;
  const H = Math.max(...ys) - y;
  const fit = (size: number, tile: number) => size / Math.max(1, Math.round(size / tile));
  const common = { id, className: colour, patternUnits: "userSpaceOnUse" as const };
  switch (kind % 5) {
    case 0:
      return (
        <pattern
          {...common}
          width="7"
          height="7"
          patternTransform={`translate(${x} ${y}) rotate(45)`}
        >
          <line x1="0" y1="0" x2="0" y2="7" strokeWidth="2.4" />
        </pattern>
      );
    case 1: {
      const w = fit(W, 9);
      const h = fit(H, 9);
      return (
        <pattern {...common} width={w} height={h} patternTransform={`translate(${x} ${y})`}>
          <circle cx={w / 4} cy={h / 4} r="1.05" />
          <circle cx={(w * 3) / 4} cy={(h * 3) / 4} r="1.05" />
        </pattern>
      );
    }
    case 2: {
      const w = fit(W, 13);
      const h = fit(H, 13);
      return (
        <pattern {...common} width={w} height={h} patternTransform={`translate(${x} ${y})`}>
          <circle className="ring" cx={w / 2} cy={h / 2} r="3.6" strokeWidth="1.1" />
        </pattern>
      );
    }
    case 3: {
      const w = fit(W, 7);
      const h = fit(H, 7);
      return (
        <pattern {...common} width={w} height={h} patternTransform={`translate(${x} ${y})`}>
          <line x1="0" y1={h / 2} x2={w} y2={h / 2} strokeWidth="1.4" />
        </pattern>
      );
    }
    default:
      return (
        <pattern
          {...common}
          width="8"
          height="8"
          patternTransform={`translate(${x} ${y}) rotate(-45)`}
        >
          <line x1="0" y1="0" x2="0" y2="8" strokeWidth="1.2" />
          <line x1="4" y1="0" x2="4" y2="8" strokeWidth="1.2" strokeDasharray="1.5 3.5" />
        </pattern>
      );
  }
}

/** An arrow is long enough to carry its label and no longer. */
const MAX_ARROW_PX = 190;

// Rough widths in pixels, to decide what fits at the bottom of a piece.
const PICTURE_PX = 39;
const LETTER_PX = 6.8;

/** The pictures of who is on a piece and when it was last worked on. Names are shown when all of
 * them fit; in a narrow piece the pictures stay and the names go (they are in the tooltips). */
function Foot({ piece, width }: { piece: Piece; width: number }) {
  const whenPx = piece.when.length * LETTER_PX + 9;
  const named =
    piece.who.reduce((sum, m) => sum + PICTURE_PX + 12 + m.handle.length * LETTER_PX, 0) + whenPx <=
    width;
  const room = Math.max(1, Math.floor((width - whenPx) / PICTURE_PX));
  const shown = piece.who.length > room ? piece.who.slice(0, Math.max(1, room - 1)) : piece.who;
  const more = piece.who.length - shown.length;
  return (
    <span className="tile-foot">
      {shown.map((m) => (
        <span key={m.handle} className="who">
          <Picture handle={m.handle} offline={m.offline} />
          {named && <span className="nm">{m.handle}</span>}
        </span>
      ))}
      {more > 0 && <span className="more">+{more}</span>}
      <span className="cut-when">{piece.when}</span>
    </span>
  );
}

/** What a piece says: its title and state, what goes on, the latest message, who is on it. */
function Inside({ piece, width }: { piece: Piece; width: number }) {
  return (
    <>
      <span className="tile-top">
        <span className="name">{piece.title}</span>
        {piece.chip && <span className={`state-chip ${piece.chip.tone}`}>{piece.chip.label}</span>}
      </span>
      {piece.doing && <span className="doing">{piece.doing}</span>}
      {piece.desc && <span className="desc">{piece.desc}</span>}
      <span className="cut-grow" />
      <Foot piece={piece} width={width} />
    </>
  );
}

/** Below this width the sheet is too small to read: the pieces become a plain list. */
const LIST_BELOW_PX = 560;

/**
 * The board as one cut sheet of interlocking pieces, with arrows for the open conversations. On a
 * narrow screen the same pieces are listed one under another, without arrows.
 */
export function CutBoard({ pieces, talks }: { pieces: Piece[]; talks: Talk[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [hot, setHot] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const weights = pieces.map((p) => p.weight);
  const weightKey = weights.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout depends only on the weights
  const grid = useMemo(() => layout(weights), [weightKey]);

  const { w, h } = size;
  const cw = w / COLS;
  const ch = h / ROWS;
  const index = new Map(pieces.map((p, i) => [p.key, i]));
  const pairs = talks.map((t): [number, number] => [
    index.get(t.from) ?? -1,
    index.get(t.to) ?? -1,
  ]);
  const lines =
    grid.length && w && h
      ? placeLabels(links(grid, pairs).map((link) => (link ? arrow(link, cw, ch) : null)))
      : [];

  if (w > 0 && w < LIST_BELOW_PX) {
    return (
      <div className="cutboard list" ref={ref}>
        {pieces.map((p) => (
          <button
            type="button"
            key={p.key}
            className={`cut-tile card ${p.colour}${p.free ? " free" : ""}`}
            onClick={p.onClick}
          >
            <Inside piece={p} width={w - 26} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="cutboard" ref={ref}>
      {w > 0 && h > 0 && grid.length > 0 && (
        <>
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            <defs>
              <linearGradient id="fade-g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
                <stop offset="0.5" stopColor="#fff" stopOpacity="0.5" />
                <stop offset="1" stopColor="#fff" />
              </linearGradient>
              <mask id="fade" maskContentUnits="objectBoundingBox">
                <rect width="1" height="1" fill="url(#fade-g)" />
              </mask>
              {pieces.map((p, i) => {
                if (p.free) return null;
                const inner = shrink(
                  shrink(
                    outline(grid, i).map(([x, y]) => [x * cw, y * ch] as Point),
                    GAP,
                  ),
                  INSET,
                );
                return (
                  <Pattern key={p.key} id={`pat-${i}`} kind={i} poly={inner} colour={p.colour} />
                );
              })}
            </defs>
            {pieces.map((p, i) => {
              const shape = shrink(
                outline(grid, i).map(([x, y]) => [x * cw, y * ch] as Point),
                GAP,
              );
              if (shape.length === 0) return null;
              const d = rounded(shape, RADIUS, GAP);
              const classes = ["piece", p.colour];
              if (p.free) classes.push("free");
              if (hot === p.key) classes.push("hot");
              return (
                <g key={p.key}>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: the text block on top is the button */}
                  <path
                    className={classes.join(" ")}
                    d={d}
                    onMouseEnter={() => setHot(p.key)}
                    onMouseLeave={() => setHot(null)}
                    onClick={p.onClick}
                  />
                  {!p.free && (
                    <>
                      <path
                        className="weave"
                        fill={`url(#pat-${i})`}
                        mask="url(#fade)"
                        d={rounded(shrink(shape, INSET), RADIUS - INSET, GAP)}
                      />
                      <path className={`rim ${p.colour}`} d={d} />
                    </>
                  )}
                </g>
              );
            })}
          </svg>

          {pieces.map((p, i) => {
            const t = textBlock(grid, i);
            if (!t) return null;
            const inset = GAP + PAD;
            const classes = ["cut-tile", p.colour];
            if (p.free) classes.push("free");
            // Short blocks show less of the latest message, the shortest none of it.
            const height = (t.r1 - t.r0) * ch - (GAP + PAD) * 2;
            if (height < 120) classes.push("tight");
            else if (height < 190) classes.push("short");
            if (hot === p.key) classes.push("hot");
            return (
              <button
                type="button"
                key={p.key}
                className={classes.join(" ")}
                style={{
                  left: t.c0 * cw + inset,
                  top: t.r0 * ch + inset,
                  width: (t.c1 - t.c0) * cw - inset * 2,
                  height: (t.r1 - t.r0) * ch - inset * 2,
                }}
                onMouseEnter={() => setHot(p.key)}
                onMouseLeave={() => setHot(null)}
                onClick={p.onClick}
              >
                <Inside piece={p} width={(t.c1 - t.c0) * cw - inset * 2} />
              </button>
            );
          })}

          <svg className="talks" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            <defs>
              {(["asking", "answered"] as const).map((k) => (
                <marker
                  key={k}
                  id={`head-${k}`}
                  className={`head-${k}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 10 5 0 10z" />
                </marker>
              ))}
            </defs>
            {talks.map((talk, i) => {
              const line = lines[i];
              if (!line) return null;
              return (
                <g key={`${talk.from}-${talk.to}-${talk.label}`}>
                  <circle
                    className={`talk-dot ${talk.state}`}
                    cx={line.p0[0]}
                    cy={line.p0[1]}
                    r="3.5"
                  />
                  <path
                    className={`talk ${talk.state}`}
                    markerEnd={`url(#head-${talk.state})`}
                    d={`M${line.p0[0]} ${line.p0[1]}Q${line.c[0]} ${line.c[1]} ${line.p1[0]} ${line.p1[1]}`}
                  />
                </g>
              );
            })}
          </svg>
          {talks.map((talk, i) => {
            const line = lines[i];
            if (!line) return null;
            return (
              <span
                key={`${talk.from}-${talk.to}-${talk.label}`}
                className={`talk-label ${talk.state}`}
                style={{ left: line.mid[0], top: line.mid[1] }}
              >
                {talk.label}
              </span>
            );
          })}
        </>
      )}
    </div>
  );
}

/** An arrow in pixels: slightly bent, with the place for its label in the middle. */
function arrow(link: Link, cw: number, ch: number): NonNullable<Line> {
  const px = (p: Point): Point => [p[0] * cw, p[1] * ch];
  const dist = (p: Point, q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  let from = px(link.from);
  let to = px(link.to);
  // Cells are taller than wide, so an arrow that runs down gets long: its ends are pulled in,
  // but never out of the pieces they belong to.
  const extra = dist(from, to) - MAX_ARROW_PX;
  if (extra > 0) {
    const pull = (end: Point, limit: Point): Point => {
      const reach = dist(end, limit);
      const k = reach > 0 ? Math.min(1, extra / 2 / reach) : 0;
      return [end[0] + (limit[0] - end[0]) * k, end[1] + (limit[1] - end[1]) * k];
    };
    from = pull(from, px(link.near[0]));
    to = pull(to, px(link.near[1]));
  }
  const len = dist(from, to) || 1;
  const bend = Math.min(18, len / 6);
  const c: Point = [
    (from[0] + to[0]) / 2 - ((to[1] - from[1]) / len) * bend,
    (from[1] + to[1]) / 2 + ((to[0] - from[0]) / len) * bend,
  ];
  const mid: Point = [
    0.25 * from[0] + 0.5 * c[0] + 0.25 * to[0],
    0.25 * from[1] + 0.5 * c[1] + 0.25 * to[1],
  ];
  return { p0: from, p1: to, c, mid };
}

type Line = { p0: Point; p1: Point; c: Point; mid: Point } | null;

/** Moves labels that would cover each other apart, one below the other. */
function placeLabels(lines: Line[]): Line[] {
  const placed: Point[] = [];
  return lines.map((line) => {
    if (!line) return line;
    const mid: Point = [line.mid[0], line.mid[1]];
    for (let moved = true, tries = 0; moved && tries < 6; tries++) {
      moved = false;
      for (const other of placed) {
        if (Math.abs(other[0] - mid[0]) < 130 && Math.abs(other[1] - mid[1]) < 26) {
          mid[1] = other[1] + 28;
          moved = true;
        }
      }
    }
    placed.push(mid);
    return { ...line, mid };
  });
}
