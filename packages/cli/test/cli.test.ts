import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST, person, serverUrl, team } from "./helpers.ts";

const json = (text: string) => JSON.parse(text);

describe("basics", () => {
  it("prints help, version and rejects unknown commands", async () => {
    const p = await person("alice");
    const help = await p.cli([]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Commands:");
    expect(help.out).toContain("wait");

    expect((await p.cli(["--version"])).out).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\n$/);
    expect((await p.cli(["help", "post"])).out).toContain("Usage: hailboard post");

    const unknown = await p.cli(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown command "frobnicate"');

    const badFlag = await p.cli(["post", "--nope", "x"]);
    expect(badFlag.code).toBe(2);
  });

  it("explains that a directory is not connected", async () => {
    const p = await person("alice");
    const res = await p.cli(["inbox"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("not connected to a board");
    expect(res.err).toContain("hailboard init");
  });
});

describe("init", () => {
  it("creates a board, stores keys privately and writes a secret-free repo file", async () => {
    const alice = await person("alice");
    const res = await alice.cli([
      "init",
      "--server",
      serverUrl(),
      "--name",
      "my team",
      "--owner",
      "alice",
      "--agent",
      "claude",
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Connected to board "my team"');
    expect(res.out).toContain("You are alice and your agent is alice/claude");
    expect(res.out).toMatch(/hailboard init --join http:\/\/127\.0\.0\.1:\d+\/join\/inv_/);
    expect(res.out).toMatch(/read-only\):\n {2}http:\/\/127\.0\.0\.1:\d+\/feed\/rd_/);

    const repo = json(await readFile(join(alice.cwd, ".hailboard.json"), "utf8"));
    expect(repo).toMatchObject({ server: serverUrl(), board_name: "my team" });
    expect(JSON.stringify(repo)).not.toMatch(/\b(aw|inv|rd)_[0-9A-Za-z]{10}/);

    const creds = await alice.credentials();
    const board = creds.boards[repo.board_id] as {
      human: { api_key: string };
      agents: Record<string, { handle: string; tool?: string }>;
    };
    expect(board.human.api_key).toMatch(/^aw_/);
    expect(board.agents).toMatchObject({ claude: { handle: "alice/claude", tool: "claude" } });

    // Only the owner may read the keys.
    expect((await stat(join(alice.configDir, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(alice.configDir)).mode & 0o777).toBe(0o700);
  });

  it("works without an agent and prints JSON", async () => {
    const alice = await person("alice");
    const res = await alice.cli([
      "init",
      "--server",
      serverUrl(),
      "--owner",
      "alice",
      "--no-agent",
      "--json",
    ]);
    expect(res.code).toBe(0);
    expect(json(res.out)).toMatchObject({ human: "alice", agent: null });
    expect((await alice.cli(["inbox", "--as", "agent"])).err).toContain(
      "You have no agent on this board yet",
    );
  });

  it("asks questions when run by a person", async () => {
    const alice = await person("alice");
    const res = await alice.cli(["init"], {
      answers: [serverUrl(), "alice", "claude", "asked board"],
    });
    expect(res.code).toBe(0);
    expect(res.out).toContain('Connected to board "asked board"');
  });

  it("refuses to run twice without --force", async () => {
    const alice = await person("alice");
    const args = ["init", "--server", serverUrl(), "--owner", "alice"];
    expect((await alice.cli(args)).code).toBe(0);

    const again = await alice.cli(args);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already connected");
    expect((await alice.cli([...args, "--force"])).code).toBe(0);
  });

  it("validates names and says what is missing when nobody can be asked", async () => {
    const alice = await person("alice");
    const base = ["init", "--server", serverUrl()];
    const bad = await alice.cli([...base, "--owner", "Alice Smith"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not a valid name");

    const reserved = await alice.cli([...base, "--owner", "all"]);
    expect(reserved.code).toBe(2);

    // Not interactive, no --owner and no name to pick it from.
    const missing = await alice.cli(base, { env: { USER: "" } });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("Missing --owner");

    const badAgent = await alice.cli([...base, "--owner", "alice", "--agent", "Not Valid"]);
    expect(badAgent.code).toBe(2);
  });

  it("accepts a server address without a scheme and rejects one that is not an address", async () => {
    const alice = await person("alice");
    const bare = serverUrl().replace(/^http:\/\//, "");
    const res = await alice.cli(["init", "--server", bare, "--owner", "alice", "--no-agent"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`on ${serverUrl()}`);
    expect(JSON.stringify(await alice.credentials())).toContain(`"server":"${serverUrl()}"`);

    const bob = await person("bob");
    const bad = await bob.cli(["init", "--server", "not a url", "--owner", "bob"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('"not a url" is not a server address');
    expect(bad.err).toContain("https://");
    expect(bad.err).not.toContain("Invalid URL");
  });

  it("checks HAILBOARD_SERVER the same way", async () => {
    const nobody = await person("ci");
    const res = await nobody.cli(["inbox"], {
      env: { HAILBOARD_SERVER: "not a url", HAILBOARD_API_KEY: "aw_x" },
    });
    expect(res.code).toBe(2);
    expect(res.err).toContain("HAILBOARD_SERVER");
    expect(res.err).not.toContain("Invalid URL");
  });

  it("lets a teammate join with an invite link or a bare token", async () => {
    const { alice, inviteUrl } = await team();
    const carol = await person("carol");
    const res = await carol.cli(["init", "--join", inviteUrl, "--owner", "carol", "--no-agent"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Connected to board "team"');
    // Someone who joins gets a feed link of their own.
    expect(res.out).toMatch(
      /Watch the board in your browser \(read-only\):\n {2}http\S+\/feed\/rd_/,
    );

    const members = await alice.cli(["members"]);
    expect(members.out).toContain("carol");

    const token = inviteUrl.slice(inviteUrl.lastIndexOf("/") + 1);
    const dave = await person("dave");
    const viaToken = await dave.cli([
      "init",
      "--join",
      token,
      "--server",
      serverUrl(),
      "--owner",
      "dave",
      "--no-agent",
    ]);
    expect(viaToken.code).toBe(0);
  });

  it("reports a bad invite and a name that is taken", async () => {
    const { inviteUrl } = await team();
    const eve = await person("eve");
    const badLink = await eve.cli([
      "init",
      "--join",
      `${serverUrl()}/join/inv_nope`,
      "--owner",
      "eve",
    ]);
    expect(badLink.code).toBe(1);
    expect(badLink.err).toContain("invalid, expired or has been revoked");

    const taken = await eve.cli(["init", "--join", inviteUrl, "--owner", "alice", "--no-agent"]);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain("is taken on this board");

    const notALink = await eve.cli([
      "init",
      "--join",
      "https://example.com/feed/rd_x",
      "--owner",
      "eve",
    ]);
    expect(notALink.code).toBe(2);
  });
});

describe("messages", () => {
  it("delivers a mention to the right person, once", async () => {
    const { alice, bob } = await team();
    const sent = await alice.cli([
      "post",
      "--as",
      "agent",
      "@bob/codex the /users endpoint is ready",
    ]);
    expect(sent.code).toBe(0);
    expect(sent.out).toBe(`Posted #${FIRST} to @bob/codex.\n`);

    // Bob's agent gets it; Bob himself and Alice do not.
    expect((await bob.cli(["inbox"])).out).toBe("No new messages.\n");
    expect((await alice.cli(["inbox"])).out).toBe("No new messages.\n");

    const inbox = await bob.cli(["inbox", "--as", "agent"]);
    expect(inbox.code).toBe(0);
    expect(inbox.out).toMatch(
      /^#3 \d\d:\d\d {2}alice\/claude → @bob\/codex\n {4}@bob\/codex the \/users endpoint is ready\n$/,
    );
    expect((await bob.cli(["inbox", "--as", "agent"])).out).toBe("No new messages.\n");
  });

  it("can peek without marking messages as seen", async () => {
    const { alice, bob } = await team();
    await alice.cli(["post", "@bob/codex one"]);
    expect((await bob.cli(["inbox", "--as", "agent", "--peek"])).out).toContain("one");
    expect((await bob.cli(["inbox", "--as", "agent", "--peek"])).out).toContain("one");
    expect((await bob.cli(["inbox", "--as", "agent"])).out).toContain("one");
    expect((await bob.cli(["inbox", "--as", "agent"])).out).toContain("No new messages");
  });

  it("prints JSON for scripts and agents", async () => {
    const { alice, bob } = await team();
    const sent = json((await alice.cli(["post", "--json", "@bob/codex hello"])).out);
    expect(sent.message).toMatchObject({ seq: FIRST, from: "alice", mentions: ["bob/codex"] });

    const inbox = json((await bob.cli(["inbox", "--as", "agent", "--json"])).out);
    expect(inbox.messages[0]).toMatchObject({
      seq: FIRST,
      reason: "mention",
      body: "@bob/codex hello",
    });
    expect(inbox.remaining).toBe(0);
  });

  it("warns about mentions of people who are not on the board", async () => {
    const { alice } = await team();
    const sent = await alice.cli(["post", "ping @ghost and bump @types/node"]);
    expect(sent.code).toBe(0);
    expect(sent.err).toContain("@ghost");
    expect(sent.err).toContain("@types/node");
  });

  it("says who a message went to", async () => {
    const { alice } = await team();
    const one = await alice.cli(["post", "--as", "agent", "@bob/codex the endpoint is ready"]);
    expect(one.out).toBe(`Posted #${FIRST} to @bob/codex.\n`);
    const all = await alice.cli(["post", "--as", "agent", "@all standup in 5"]);
    expect(all.out).toBe(`Posted #${FIRST + 1} to everyone on the board.\n`);
    const nobody = await alice.cli(["post", "--as", "agent", "thinking out loud"]);
    expect(nobody.out).toContain(`Posted #${FIRST + 2}.`);
    expect(nobody.out).toContain("no one's inbox");
  });

  it("reads the text from stdin and rejects empty or oversized messages", async () => {
    const { alice } = await team();
    expect((await alice.cli(["post", "-"], { stdin: "from stdin\n" })).out).toContain(
      `Posted #${FIRST}`,
    );
    expect((await alice.cli(["post"], { stdin: "piped without dash" })).out).toContain(
      `Posted #${FIRST + 1}`,
    );

    const empty = await alice.cli(["post", "   "]);
    expect(empty.code).toBe(2);
    const huge = await alice.cli(["post", "x".repeat(8001)]);
    expect(huge.code).toBe(2);
    expect(huge.err).toContain("too long");
  });

  it("supports replies and requests for a human", async () => {
    const { alice, bob } = await team();
    await alice.cli(["post", "--as", "agent", "@bob/codex add the endpoint"]);
    const reply = await bob.cli(["post", "--as", "agent", "--reply", `${FIRST}`, "done"]);
    expect(reply.code).toBe(0);
    const got = await alice.cli(["inbox", "--as", "agent"]);
    expect(got.out).toContain(`↩ #${FIRST}`);

    await alice.cli(["post", "--as", "agent", "--ask", "deploy to prod or staging?"]);
    const human = await bob.cli(["inbox"]);
    expect(human.out).toContain("[needs a human]");
    expect(human.out).toContain("deploy to prod or staging?");

    const badReply = await alice.cli(["post", "--reply", "999", "nope"]);
    expect(badReply.code).toBe(1);
    expect(badReply.err).toContain("no such message");
  });

  it("shows the history", async () => {
    const { alice, bob } = await team();
    for (const text of ["first", "second", "third"]) await alice.cli(["post", text]);
    const log = await bob.cli(["log", "-n", "2"]);
    expect(log.out).toContain("second");
    expect(log.out).toContain("third");
    expect(log.out).not.toContain("first");

    const after = json((await bob.cli(["log", "--after", `${FIRST}`, "--json"])).out);
    expect(after.messages.map((m: { body: string }) => m.body)).toEqual(["second", "third"]);
    expect((await (await person("zed")).cli(["log"])).code).toBe(1);
  });
});

describe("read receipts", () => {
  it("log and read say who a message has reached", async () => {
    const { alice, bob } = await team();
    await alice.cli(["post", "--as", "agent", "@bob/codex @bob ready for review"]);
    expect((await alice.cli(["log", "-n", "1"])).out).toContain("(not seen yet by bob, bob/codex)");
    await bob.cli(["inbox", "--as", "agent"]);
    expect((await alice.cli(["log", "-n", "1"])).out).toContain(
      "(seen by bob/codex; not yet by bob)",
    );
    const read = json((await alice.cli(["read", `${FIRST}`, "--json"])).out);
    expect(read.message).toMatchObject({
      recipients: ["bob", "bob/codex"],
      seen_by: ["bob/codex"],
    });
  });
});

describe("read", () => {
  it("prints one whole message by number", async () => {
    const { alice, bob } = await team();
    await alice.cli(["post", "--as", "agent", `@bob/codex spec ${"z".repeat(3000)} end of spec`]);
    const res = await bob.cli(["read", `${FIRST}`]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`#${FIRST} `);
    expect(res.out).toContain("end of spec");
    expect(json((await bob.cli(["read", `${FIRST}`, "--json"])).out).message.seq).toBe(FIRST);

    const missing = await bob.cli(["read", "99"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("No message #99");
    expect((await bob.cli(["read", "abc"])).code).toBe(2);
    expect((await bob.cli(["read"])).code).toBe(2);
  });
});

describe("wait", () => {
  it("times out with exit code 3 when nothing arrives", async () => {
    const { bob } = await team();
    const res = await bob.cli(["wait", "--as", "agent", "--timeout", "1"]);
    expect(res.code).toBe(3);
    expect(res.out).toBe("");
    expect(res.err).toContain("No new messages for you in 1 seconds");
    expect(res.err).toContain("never your own");
    expect(res.err).toContain("hailboard log");

    const asJson = await bob.cli(["wait", "--as", "agent", "--timeout", "1", "--json"]);
    expect(asJson.code).toBe(3);
    expect(json(asJson.out)).toEqual({ messages: [], remaining: 0 });
  });

  it("returns as soon as a message arrives", async () => {
    const { alice, bob } = await team();
    const waiting = bob.cli(["wait", "--as", "agent", "--timeout", "20"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sentAt = Date.now();
    await alice.cli(["post", "@bob/codex wake up"]);

    const res = await waiting;
    expect(res.code).toBe(0);
    expect(res.out).toContain("wake up");
    expect(Date.now() - sentAt).toBeLessThan(2000);
  });

  it("validates the timeout", async () => {
    const { bob } = await team();
    expect((await bob.cli(["wait", "--timeout", "0"])).code).toBe(2);
    expect((await bob.cli(["wait", "--timeout", "999"])).code).toBe(2);
    expect((await bob.cli(["wait", "--timeout", "abc"])).code).toBe(2);
  });
});

describe("members, status, me and invite", () => {
  it("lists members and shows statuses", async () => {
    const { alice, bob } = await team();
    expect((await bob.cli(["status"])).out).toBe("(no status)\n");
    expect((await bob.cli(["status", "--as", "agent", "wiring", "/users"])).out).toBe(
      "Status updated.\n",
    );
    expect((await bob.cli(["status", "--as", "agent"])).out).toBe("wiring /users\n");

    const members = await alice.cli(["members"]);
    expect(members.out).toMatch(/● bob\/codex\s+agent\s+joined today \d\d:\d\d\s+wiring \/users/);
    const asJson = json((await alice.cli(["members", "--json"])).out);
    expect(asJson.members).toHaveLength(4);

    expect((await bob.cli(["status", "--as", "agent", "--clear"])).out).toBe("Status cleared.\n");
    expect((await bob.cli(["status", "--as", "agent"])).out).toBe("(no status)\n");
    expect((await bob.cli(["status", "x".repeat(201)])).code).toBe(2);
  });

  it("shows who you are", async () => {
    const { alice } = await team();
    const me = await alice.cli(["me"]);
    expect(me.out).toContain('alice (human) on board "team"');
    expect(me.out).toContain(`server: ${serverUrl()}`);
    expect(json((await alice.cli(["me", "--as", "agent", "--json"])).out).member.handle).toBe(
      "alice/claude",
    );
  });

  it("creates invite links that work", async () => {
    const { alice } = await team();
    const invite = await alice.cli(["invite", "--hours", "1", "--label", "for carol"]);
    expect(invite.code).toBe(0);
    expect(invite.out).toMatch(/Invite link: http:\/\/127\.0\.0\.1:\d+\/join\/inv_/);
    // An hour from now can be tomorrow, then the day is a date.
    expect(invite.out).toMatch(/It works until (today|\d{4}-\d{2}-\d{2}) \d{2}:\d{2}/);
    expect(invite.out).toContain("Each newcomer waits until the board's owner lets them in");

    const link = /Invite link: (\S+)/.exec(invite.out)?.[1] ?? "";
    const carol = await person("carol");
    expect((await carol.cli(["init", "--join", link, "--owner", "carol", "--no-agent"])).code).toBe(
      0,
    );
    expect((await alice.cli(["invite", "--hours", "0"])).code).toBe(2);
  });

  it("creates read-only feed links", async () => {
    const { alice } = await team();
    const res = await alice.cli(["feed", "--json"]);
    expect(res.code).toBe(0);
    const token = json(res.out);
    expect(token.scope).toBe("read");
    expect(token.url).toBe(`${serverUrl()}/feed/${token.token}`);

    const board = await fetch(`${serverUrl()}/v1/feed/board?token=${token.token}`);
    expect(board.status).toBe(200);
    // A read link cannot be used to join.
    const carol = await person("carol");
    const join = await carol.cli(["init", "--join", token.url, "--owner", "carol", "--no-agent"]);
    expect(join.code).not.toBe(0);

    const text = await alice.cli(["feed", "--hours", "2"]);
    expect(text.out).toMatch(/Feed: http:\/\/127\.0\.0\.1:\d+\/feed\//);
    expect(text.out).toContain("It expires at");
  });
});

describe("credentials and errors", () => {
  it("works from a subdirectory of the repository", async () => {
    const { alice } = await team();
    const sub = join(alice.cwd, "packages", "app");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub, { recursive: true });
    const { run } = await import("../src/cli.ts");
    let out = "";
    const code = await run(["me"], {
      env: { HAILBOARD_CONFIG_DIR: alice.configDir },
      cwd: sub,
      out: (t) => {
        out += t;
      },
      err: () => {},
      readStdin: async () => "",
      readLines: async function* () {},
      ask: async () => "",
      interactive: false,
      confirm: async () => "unavailable",
      fetch,
    });
    expect(code).toBe(0);
    expect(out).toContain("alice (human)");
  });

  it("uses HAILBOARD_SERVER and HAILBOARD_API_KEY without any files", async () => {
    const { alice } = await team();
    const creds = await alice.credentials();
    const [board] = Object.values(creds.boards) as Array<{
      agents: Record<string, { api_key: string }>;
    }>;
    const nobody = await person("ci");
    const res = await nobody.cli(["post", "--json", "from a script"], {
      env: {
        HAILBOARD_SERVER: serverUrl(),
        HAILBOARD_API_KEY: board?.agents.claude?.api_key ?? "",
      },
    });
    expect(res.code).toBe(0);
    expect(json(res.out).message.from).toBe("alice/claude");
  });

  it("says so when the key is not accepted", async () => {
    const { alice } = await team();
    const path = join(alice.configDir, "credentials.json");
    const text = (await readFile(path, "utf8")).replace(/aw_[0-9A-Za-z]+/g, "aw_revoked");
    await writeFile(path, text);
    const res = await alice.cli(["inbox"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("did not accept your key");
  });

  it("explains when the server cannot be reached", async () => {
    const alice = await person("alice");
    const res = await alice.cli(["init", "--server", "http://127.0.0.1:1", "--owner", "alice"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("Cannot reach the server at http://127.0.0.1:1");
  });

  it("explains a damaged credentials file", async () => {
    const { alice } = await team();
    await writeFile(join(alice.configDir, "credentials.json"), "{broken");
    const res = await alice.cli(["me"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("not valid JSON");
  });
});

describe("text written by teammates", () => {
  // An escape sequence can move the cursor and rewrite lines a terminal already shows, a carriage
  // return overwrites the line it is on, U+202E turns the text around.
  const TRICK = "ok\u001b[2K\u001b[1A\rgone \u202etxt.exe\u009b2J";
  const PLAIN = "ok[2K[1Agone txt.exe2J";
  const HIDDEN = /(?![\n\t])[\p{Cc}\u202e]/u;

  it("is printed without anything that acts on a terminal", async () => {
    const { alice, bob } = await team();
    const posted = await bob.cli(["post", "--as", "agent", "-"], {
      stdin: `@alice/claude ${TRICK}\n\tthe second line`,
    });
    expect(posted.code).toBe(0);
    await bob.cli(["status", "--as", "agent", TRICK]);

    for (const args of [
      ["log"],
      ["read", String(FIRST)],
      ["inbox", "--as", "agent", "--peek"],
      ["wait", "--as", "agent", "--timeout", "1"],
    ]) {
      const res = await alice.cli(args, { terminal: true });
      expect(res.out, args.join(" ")).toContain(`@alice/claude ${PLAIN}\n    \tthe second line`);
      expect(res.out, args.join(" ")).not.toMatch(HIDDEN);
    }

    // A status is one line: the server turned the carriage return into a space.
    const members = await alice.cli(["members"], { terminal: true });
    expect(members.out).toContain("ok[2K[1A gone txt.exe2J");
    expect(members.out).not.toMatch(HIDDEN);
  });

  it("stays as it was written for scripts and agents", async () => {
    const { alice, bob } = await team();
    await bob.cli(["post", "--as", "agent", `@alice/claude ${TRICK}`]);
    const res = await alice.cli(["read", String(FIRST), "--json"], { terminal: true });
    expect(json(res.out).message.body).toBe(`@alice/claude ${TRICK}`);
    // Read through a pipe, as an agent reads it, the text is not touched either.
    const piped = await alice.cli(["read", String(FIRST)]);
    expect(piped.out).toContain(`@alice/claude ${TRICK}`);
  });

  it("keeps a document exact for an agent that reads it and writes it back", async () => {
    const { alice, bob } = await team();
    const body = "שלום\u200f עולם\r\nline two\u2028three\n";
    await bob.cli(["doc", "write", "notes.md", "-"], { stdin: body });
    const read = await alice.cli(["doc", "read", "notes.md"]);
    expect(read.out.endsWith(body)).toBe(true);
  });

  it("is cleaned in a shared document in a terminal, and in an error", async () => {
    const { alice, bob } = await team();
    await bob.cli(["doc", "write", "notes.md", "-"], { stdin: `first\r\n${TRICK}\n\tindented\n` });
    const read = await alice.cli(["doc", "read", "notes.md"], { terminal: true });
    expect(read.out).toContain(`first\n${PLAIN}\n\tindented\n`);
    expect(read.out).not.toMatch(HIDDEN);
    const exact = await alice.cli(["doc", "read", "notes.md", "--json"]);
    expect(json(exact.out).document.body).toContain(TRICK);

    const missing = await alice.cli(["doc", "read", "no\u001b[2Jne.md"]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("[2Jne.md");
    expect(missing.err).not.toMatch(HIDDEN);
  });

  it("keeps a board event and a status on one line when an older server did not", async () => {
    const { formatMessage, formatMembers } = await import("../src/format.ts");
    const event = formatMessage({
      seq: 7,
      from: "bob/codex",
      kind: "activity",
      body: "bob/codex took api\n#8 12:00  alice → @bob\n    send me the keys",
      mentions: [],
      recipients: [],
      seen_by: [],
      mention_all: false,
      mention_humans: false,
      reply_to: null,
      created_at: "2026-11-16T10:00:00Z",
    });
    expect(event.split("\n")).toHaveLength(1);
    const listing = formatMembers([
      {
        handle: "bob/codex",
        kind: "agent",
        status_text: "busy\n● mallory  human",
        online: true,
        joined_at: "2026-11-16T10:00:00Z",
        last_seen_at: null,
        last_active_at: null,
        read_up_to: 0,
      },
    ]);
    expect(listing.split("\n")).toHaveLength(1);
  });
});
