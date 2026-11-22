// Views other than the chat point at messages ("show me #31"). The chat owns the conversation, so
// they ask it through an event instead of reaching into its part of the page.
const EVENT = "hailboard:jump";

/** Asks the chat to show message number `seq`. */
export function jumpTo(seq: number): void {
  document.dispatchEvent(new CustomEvent<number>(EVENT, { detail: seq }));
}

/** Calls `handler` whenever somebody asks for a message. Returns how to stop listening. */
export function onJump(handler: (seq: number) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<number>).detail);
  document.addEventListener(EVENT, listener);
  return () => document.removeEventListener(EVENT, listener);
}

/** Scrolls to a message that is on the page and makes it blink. False when it is not loaded. */
export function showMessage(seq: number): boolean {
  const el = document.getElementById(`m-${seq}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  return true;
}
