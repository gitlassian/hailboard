import { createContext, type ReactNode, useContext } from "react";
import { agentOf, type Look, lookOf, type Shape } from "../people.ts";
import { LOGOS, type Logo, SPRITE } from "./logos.ts";

/** Every person's look on this board; filled by the board page from its members. */
export const LooksContext = createContext<Map<string, Look>>(new Map());

/** The hidden sprite with the agent logos. Rendered once per page. */
export function LogoSprite() {
  return (
    <svg
      className="sprite"
      width="0"
      height="0"
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static markup shipped with the app
      dangerouslySetInnerHTML={{ __html: SPRITE }}
    />
  );
}

// Each shape is drawn twice: a white halo underneath, then the body in the person colour.
const FLOWER = [
  [12, 12, 6],
  [17.6, 12, 4.3],
  [14.8, 16.85, 4.3],
  [9.2, 16.85, 4.3],
  [6.4, 12, 4.3],
  [9.2, 7.15, 4.3],
  [14.8, 7.15, 4.3],
] as const;
const STAR = "12,3.2 14.8,9.2 20.8,12 14.8,14.8 12,20.8 9.2,14.8 3.2,12 9.2,9.2";
const TRIANGLE = "12,5 19.6,17.4 4.4,17.4";

function Body({ shape, halo }: { shape: Shape; halo: boolean }) {
  switch (shape) {
    case "flower":
      return (
        <>
          {FLOWER.map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </>
      );
    case "squircle":
      return (
        <rect x="4.6" y="4.6" width="14.8" height="14.8" rx="4.6" transform="rotate(14 12 12)" />
      );
    case "triangle":
      return <polygon points={TRIANGLE} strokeWidth={halo ? 7.2 : 4.4} />;
    case "star":
      return <polygon points={STAR} strokeWidth={halo ? 5.8 : 3} />;
  }
}

// The eyes lean with the shape.
const EYES: Record<Shape, { y: number; tilt: number; left: number; right: number; drop: number }> =
  {
    flower: { y: 10.1, tilt: 0, left: 9.3, right: 12.9, drop: 0 },
    squircle: { y: 9.9, tilt: -14, left: 9.2, right: 12.8, drop: 0.8 },
    triangle: { y: 11.7, tilt: -10, left: 9.5, right: 12.7, drop: 0 },
    star: { y: 10.1, tilt: -12, left: 9.3, right: 12.9, drop: 0 },
  };

function Eyes({ shape }: { shape: Shape }) {
  const e = EYES[shape];
  return (
    <>
      {[
        [e.left, e.y],
        [e.right, e.y + e.drop],
      ].map(([x, y]) => (
        <rect
          key={x}
          className="eye"
          x={x}
          y={y}
          width="1.8"
          height="3.8"
          rx="0.9"
          transform={`rotate(${e.tilt} ${(x as number) + 0.9} ${(y as number) + 1.9})`}
        />
      ))}
    </>
  );
}

function Sticker({ agent }: { agent: string }) {
  const logo = (LOGOS as readonly string[]).includes(agent) ? (agent as Logo) : null;
  let layers: ReactNode;
  if (logo === "hermes") {
    layers = (
      <>
        <rect className="halo" width="24" height="24" rx="6" />
        <use
          className="top"
          href="#lg-hermes"
          width="24"
          height="24"
          clipPath="url(#hermes-clip)"
        />
      </>
    );
  } else if (logo) {
    layers = (
      <>
        {/* The symbol has two units of room around the 24×24 logo (see logos.ts). */}
        <use className="halo" href={`#lg-${logo}`} x="-2" y="-2" width="28" height="28" />
        <use className="top" href={`#lg-${logo}`} x="-2" y="-2" width="28" height="28" />
      </>
    );
  } else {
    // An agent without a logo: its first letter on a plain badge.
    layers = (
      <>
        <rect className="halo" width="24" height="24" rx="7" />
        <rect className="plain" x="1.5" y="1.5" width="21" height="21" rx="6" />
        <text x="12" y="16.6" textAnchor="middle">
          {agent.slice(0, 1).toUpperCase()}
        </text>
      </>
    );
  }
  return (
    <svg className={`lg lg-${logo ?? "other"}`} viewBox="0 0 24 24" aria-hidden="true">
      <g transform="translate(2.2 2.2) scale(0.817)">{layers}</g>
    </svg>
  );
}

/**
 * A member's picture: the person as a character, and for an agent its logo as a sticker at the
 * lower right corner. The sticker hangs outside the box on purpose; parents must not clip it.
 */
export function Picture({
  handle,
  small = false,
  offline = false,
}: {
  handle: string;
  small?: boolean;
  offline?: boolean;
}) {
  const looks = useContext(LooksContext);
  const look = lookOf(handle, looks);
  const agent = agentOf(handle);
  const classes = ["pic", `p${look.colour}`];
  if (small) classes.push("sm");
  if (offline) classes.push("off");
  return (
    <span className={classes.join(" ")} title={handle}>
      <svg className="av" viewBox="0 0 24 24" aria-hidden="true">
        <g className="halo">
          <Body shape={look.shape} halo />
        </g>
        <g className="body">
          <Body shape={look.shape} halo={false} />
        </g>
        <Eyes shape={look.shape} />
      </svg>
      {agent && <Sticker agent={agent} />}
    </span>
  );
}

/** A picture with the handle next to it. */
export function Identity({
  handle,
  small = false,
  offline = false,
  className,
}: {
  handle: string;
  small?: boolean;
  offline?: boolean;
  className?: string;
}) {
  return (
    <span className={className ? `idn ${className}` : "idn"}>
      <Picture handle={handle} small={small} offline={offline} />
      <span className="nm">{handle}</span>
    </span>
  );
}

/** The person colour class for a handle, for text such as names and mentions. */
export function useColour(handle: string): string {
  const looks = useContext(LooksContext);
  return `p${lookOf(handle, looks).colour}`;
}
