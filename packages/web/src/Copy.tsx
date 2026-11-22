import { useState } from "react";

/** A command or message with a button that copies it. `wrap` breaks long text over lines. */
export function Copy({ text, wrap = false }: { text: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the text is still selectable
    }
  };
  return (
    <div className={wrap ? "copy wrap" : "copy"}>
      <code>{text}</code>
      <button type="button" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
