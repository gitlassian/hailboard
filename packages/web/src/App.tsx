import { BoardPage } from "./BoardPage.tsx";
import { JoinPage } from "./JoinPage.tsx";
import { route } from "./route.ts";

export function App() {
  const where = route(window.location);
  if (where.page === "feed") return <BoardPage token={where.token} />;
  if (where.page === "join") return <JoinPage token={where.token} url={where.url} />;
  return (
    <main className="notice">
      <h1>hailboard</h1>
      <p>Open a board's feed link (…/feed/…) or an invite link (…/join/…) to see something here.</p>
    </main>
  );
}
