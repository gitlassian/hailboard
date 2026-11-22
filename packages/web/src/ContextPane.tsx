import { useEffect, useState } from "react";
import { fetchDocument, fetchDocuments } from "./api.ts";
import { Icon } from "./Icon.tsx";
import type { Document, DocumentInfo } from "./protocol.ts";
import { orderDocuments } from "./state.ts";
import { ago } from "./text.ts";

/**
 * What every agent knows: the board's shared documents as tabs. The list is loaded again whenever
 * `changes` grows (the number of board events seen, which include document changes).
 */
export function ContextPane({
  token,
  changes,
  now,
}: {
  token: string;
  changes: number;
  now: number;
}) {
  const [list, setList] = useState<DocumentInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `changes` is the reload signal
  useEffect(() => {
    let cancelled = false;
    fetchDocuments(token)
      .then((documents) => {
        if (!cancelled) setList(orderDocuments(documents));
      })
      .catch(() => {
        if (!cancelled) setList([]); // an older server without documents: show none
      });
    return () => {
      cancelled = true;
    };
  }, [token, changes]);

  // The open document: the chosen one while it exists, otherwise the first.
  const current = list?.find((d) => d.name === selected) ?? list?.[0] ?? null;
  const currentName = current?.name ?? null;
  const currentVersion = current?.version ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version of the open document is fetched again
  useEffect(() => {
    if (currentName === null) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    fetchDocument(token, currentName).then(
      (d) => {
        if (!cancelled) setDoc(d);
      },
      () => {
        if (!cancelled) setDoc(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, currentName, currentVersion]);

  return (
    <div className="pane">
      <div className="card-head">
        <span>Context</span>
        {list && list.length > 0 && (
          <span className="r">
            {list.length} {list.length === 1 ? "document" : "documents"}
          </span>
        )}
      </div>
      <div className="scroll">
        {list === null && <p className="pane-note">Loading…</p>}
        {list?.length === 0 && (
          <div className="pane-note">
            <p>No shared documents yet.</p>
            <p>
              An agent writes one with <code>hailboard doc write plan.md</code> or the MCP{" "}
              <code>write_doc</code> tool. A pinned document reaches every agent when its session
              starts.
            </p>
          </div>
        )}
        {current && (
          <div className="sheet">
            <div className="doc-tabs" role="tablist">
              {list?.map((d) => (
                <button
                  type="button"
                  role="tab"
                  key={d.name}
                  aria-selected={d.name === current.name}
                  className={d.name === current.name ? "doc-tab on" : "doc-tab"}
                  onClick={() => setSelected(d.name)}
                >
                  {d.pinned && <Icon name="pin" className="doc-pin" />}
                  {d.name}
                </button>
              ))}
            </div>
            <div className="sheet-head">
              <div className="sheet-title">
                {current.name}
                {current.pinned && (
                  <span
                    className="chip"
                    title="Every agent reads this document when a session starts"
                  >
                    board context
                  </span>
                )}
              </div>
              <div className="sheet-meta">
                v{current.version} · changed {ago(current.updated_at, now) ?? "just now"} by{" "}
                {current.updated_by}
              </div>
            </div>
            <pre className="sheet-body">{doc?.name === current.name ? doc.body : "Loading…"}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
