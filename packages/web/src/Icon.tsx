// Line icons from the open Lucide set (ISC licence), drawn with the current text colour.
const PATHS = {
  check: <path d="M20 6 9 17l-5-5" />,
  checks: (
    <>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </>
  ),
  reply: (
    <>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `ic ${className}` : "ic"} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** The hailboard mark: a lowercase h cut from one block. Takes the colour of the text around it. */
export function Mark() {
  return (
    <svg viewBox="0 0 100 100" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M11,0H41V36H57A32,32 0 0 1 89,68V100H59V72A9,9 0 0 0 41,72V100H11Z" />
    </svg>
  );
}
