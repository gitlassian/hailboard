import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface Choice<T extends string> {
  value: T;
  label: ReactNode;
  /** A small number after the label. */
  count?: number | undefined;
}

/**
 * A row of choices of which one is on, with a highlight that slides to it. With `tabs` the choices
 * switch views (a tab list); without, they are a group of toggle buttons, such as a filter.
 */
export function Segmented<T extends string>({
  value,
  choices,
  onChange,
  label,
  tabs = false,
}: {
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  /** What the control is for, for screen readers. */
  label: string;
  tabs?: boolean;
}) {
  const ref = useRef<HTMLDivElement & HTMLFieldSetElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [moving, setMoving] = useState(false);
  // Anything that can change where the choice that is on sits, or how wide it is.
  const shape = choices.map((c) => `${c.value}:${c.count ?? ""}`).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` and `shape` decide where the highlight goes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>("[data-on]");
      const next = on ? { left: on.offsetLeft, width: on.offsetWidth } : null;
      setThumb((prev) =>
        prev && next && prev.left === next.left && prev.width === next.width ? prev : next,
      );
    };
    place();
    // Fonts that load late and a resized window move the choices.
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, shape]);

  // The highlight appears in place; only later changes slide.
  useEffect(() => {
    const id = requestAnimationFrame(() => setMoving(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const inside = (
    <>
      {thumb && (
        <span
          className={moving ? "seg-thumb moving" : "seg-thumb"}
          style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
        />
      )}
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            className={on ? "seg-item on" : "seg-item"}
            data-on={on ? "" : undefined}
            {...(tabs ? { role: "tab", "aria-selected": on } : { "aria-pressed": on })}
            onClick={() => onChange(c.value)}
          >
            {c.label}
            {c.count !== undefined && <span className="n">{c.count}</span>}
          </button>
        );
      })}
    </>
  );
  return tabs ? (
    <div className="seg" ref={ref} role="tablist" aria-label={label}>
      {inside}
    </div>
  ) : (
    <fieldset className="seg" ref={ref} aria-label={label}>
      {inside}
    </fieldset>
  );
}
