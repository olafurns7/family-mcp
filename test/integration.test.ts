import { test, expect } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { pathToFileURL } from "node:url";
import { Cookie } from "tough-cookie";
import { AblerClient } from "../src/api.js";
import { captureCookies, importCookies, loadSession, ORIGIN, saveSession } from "../src/auth.js";

const eventBase = { name: "Practice", from: "2026-09-11T16:00:00Z", to: "2026-09-11T17:00:00Z",
  ageGroup: { id: "age-group", name: "Team" }, currentPlayerAttendance: [] };

const cookie = { name: "refreshToken", value: "private-refresh", domain: "www.abler.io", path: "/", expires: Date.now() / 1000 + 3600 };

test("private cookie import, renewal, pagination, validation, and redacted failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abler-test-"));
  const path = join(directory, "session.json");
  try {
    await expect(importCookies({ cookies: [{ ...cookie, domain: "unrelated.example" }] })).rejects.toThrow("refreshToken");
    await expect(importCookies({ cookies: [{ ...cookie, expires: 0 }] })).rejects.toThrow("refreshToken");
    await expect(importCookies({ cookies: [{ ...cookie, value: "x\r\nInjected: bad" }] })).rejects.toThrow("Invalid");
    const jar = await importCookies({ cookies: [cookie, { ...cookie, name: "_analytics" },
      { ...cookie, name: "id_token", value: "private-stale", expires: Date.now() / 1000 + 30 }] });
    await saveSession(path, jar);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("_analytics");
    let renewals = 0;
    let queries = 0;
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url).startsWith(ORIGIN)).toBe(true);
      expect(options?.redirect).toBe("error");
      const headers = new Headers(options?.headers);
      if (String(url).endsWith("/oauth/token")) {
        renewals++;
        expect(headers.get("cookie")).toContain("refreshToken=");
        const response = Response.json({ access_token: "private-access" });
        response.headers.append("Set-Cookie", `id_token=private-access; Path=/; Max-Age=600; HttpOnly`);
        response.headers.append("Set-Cookie", `refreshToken=rotated-${renewals}; Path=/; Max-Age=3600; HttpOnly`);
        return response;
      }
      queries++;
      expect(headers.get("cookie")).toContain("id_token=private-access");
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.cookies.find((c: { name: string }) => c.name === "refreshToken").value).toBe(`rotated-${renewals}`);
      const body = JSON.parse(String(options?.body));
      if (queries === 1) return Response.json({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] });
      if (body.operationName === "Schedule") {
        expect(body.variables.filter).toEqual({ dateFrom: "2026-09-11", dateTo: "2026-09-30", label: ["TRAINING"] });
        return Response.json({ data: { schedule: { edges: [{ node: { ...eventBase, eventId: body.variables.cursor || "one" } }], pageInfo: { hasNextPage: !body.variables.cursor, endCursor: "opaque-next" } } } });
      }
      return Response.json({ errors: [{ message: "private-refresh private-access" }] });
    }) as typeof fetch;
    const client = new AblerClient(path, request);
    const filter = { from: "2026-09-11", to: "2026-09-30", types: ["TRAINING" as const], first: 1 };
    const first = await client.schedule(filter);
    const second = await client.schedule({ ...filter, after: first.pageInfo.endCursor! });
    expect(first.events[0]?.eventId).toBe("one");
    expect(second.events[0]?.eventId).toBe("opaque-next");
    expect(second.pageInfo.hasNextPage).toBe(false);
    expect(renewals).toBe(2);
    await expect(client.schedule({ from: "2026-02-30" })).rejects.toThrow();
    await expect(client.schedule({ from: "2026-09-30", to: "2026-09-11" })).rejects.toThrow();
    await expect(client.schedule({ first: 101 })).rejects.toThrow();
    await expect(client.schedule({ participantId: "child-a" } as never)).rejects.toThrow();
    await expect(client.schedule({ participantIds: [] })).rejects.toThrow();
    await expect(client.status()).rejects.toThrow("Abler rejected SessionStatus");
    const stored = await loadSession(path);
    const access = (await stored.getCookies(ORIGIN)).find(c => c.key === "id_token")!;
    expect(access.TTL()).toBeGreaterThan(500000);
    expect(access.TTL()).toBeLessThanOrEqual(600000);
    expect(access.secure).toBe(true);
    await stored.setCookie(Cookie.parse("refreshToken=deleted; Path=/; Max-Age=0")!, ORIGIN);
    await saveSession(path, stored);
    await expect(loadSession(path)).rejects.toThrow("expired");
    await saveSession(path, jar);
    const revoked = new AblerClient(path, (async () => Response.json({ error: "private-refresh" }, { status: 401 })) as typeof fetch);
    await expect(revoked.status()).rejects.toThrow("expired or was revoked");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome capture is limited to loopback and to the Abler tab", async () => {
  await expect(captureCookies("https://example.com")).rejects.toThrow("loopback");
  const mockChrome = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/json/list") return Response.json([
        { type: "page", url: "https://unrelated.example", webSocketDebuggerUrl: "ws://unrelated.example" },
        { type: "page", url: `${ORIGIN}/coach`, webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/1` },
      ]);
      if (server.upgrade(request)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message));
        expect(request.method).toBe("Network.getCookies");
        expect(request.params.urls).toEqual([`${ORIGIN}/oauth/token`, `${ORIGIN}/graphql`]);
        socket.send(JSON.stringify({ id: request.id, result: { cookies: [cookie] } }));
      },
    },
  });
  try {
    const jar = await captureCookies(`http://127.0.0.1:${mockChrome.port}`);
    expect(await jar.getCookieString(ORIGIN)).toBe("refreshToken=private-refresh");
  } finally { mockChrome.stop(true); }
});

test("MCP executable exposes only read tools and reports missing auth without protocol noise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abler-mcp-test-"));
  const client = new Client({ name: "abler-check", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: "bun", args: ["src/cli.ts"],
    env: { ...process.env, ABLER_SESSION_FILE: join(directory, "missing.json") } as Record<string, string>, stderr: "pipe" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(["auth_status", "get_event", "get_profile", "list_child_schedules", "list_groups", "list_schedule"]);
    expect(tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
    const result = await client.callTool({ name: "auth_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("No saved Abler session");
    const typo = await client.callTool({ name: "list_child_schedules", arguments: { childId: "only-this-child" } });
    expect(typo.isError).toBe(true);
    const invalid = await client.callTool({ name: "list_schedule", arguments: { first: 0 } });
    expect(invalid.isError).toBe(true);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test("child schedules separate siblings by ID, retain empty children, and paginate independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abler-children-test-"));
  const path = join(directory, "session.json");
  const linkedChildren = [
    { id: "child-a", displayName: "Alex" },
    { id: "child-b", displayName: "Alex" },
    { id: "child-c", displayName: "Jamie" },
  ];
  let noChildren = false;
  const requests: { child: string; cursor: string | null }[] = [];
  try {
    await saveSession(path, await importCookies({ cookies: [cookie, { ...cookie, name: "id_token" }] }));
    const request = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.operationName === "Profile") return Response.json({ data: { me: {
        id: "parent", displayName: "Parent", children: noChildren ? [] : linkedChildren,
      } } });
      expect(body.operationName).toBe("Schedule");
      expect(body.variables.first).toBe(1);
      expect(body.variables.filter.participant).toHaveLength(1);
      const child = body.variables.filter.participant[0];
      const cursor = body.variables.cursor;
      requests.push({ child, cursor });
      return Response.json({ data: { schedule: {
        edges: child === "child-c" ? [] : [{ node: {
          ...eventBase, eventId: cursor ? "next-event" : "shared-event",
          currentPlayerAttendance: [
            { player: linkedChildren[0], status: "G", coachStatus: "P" },
            { player: linkedChildren[1], status: "N", coachStatus: null },
          ],
        } }],
        pageInfo: { hasNextPage: child === "child-a" && !cursor, endCursor: child === "child-a" ? "a-next" : null },
      } } });
    }) as typeof fetch;
    const client = new AblerClient(path, request);
    expect((await client.profile()).childNamesById).toEqual({ "child-a": "Alex", "child-b": "Alex", "child-c": "Jamie" });
    const result = await client.childSchedules({ first: 1 });
    expect(result.children.map(c => c.child)).toEqual(linkedChildren);
    expect(result.children[0]?.events[0]).toMatchObject({ eventId: "shared-event", attendance: [{ status: "G", coachStatus: "P" }] });
    expect(result.children[1]?.events[0]).toMatchObject({ eventId: "shared-event", attendance: [{ status: "N", coachStatus: null }] });
    expect(result.children[2]).toEqual({ child: linkedChildren[2], events: [], pageInfo: { hasNextPage: false, endCursor: null } });
    expect(result.children.map(c => c.pageInfo.hasNextPage)).toEqual([true, false, false]);
    const next = await client.childSchedules({ childIds: ["child-a"], first: 1, afterByChild: { "child-a": "a-next" } });
    expect(next.children).toHaveLength(1);
    expect(next.children[0]?.events[0]?.eventId).toBe("next-event");
    expect(requests).toEqual([
      { child: "child-a", cursor: null }, { child: "child-b", cursor: null },
      { child: "child-c", cursor: null }, { child: "child-a", cursor: "a-next" },
    ]);
    await expect(client.childSchedules({ childIds: ["unlinked"] })).rejects.toThrow("Unknown child");
    await expect(client.childSchedules({ childIds: ["child-a"], afterByChild: { "child-b": "b-next" } })).rejects.toThrow("unselected child");
    await expect(client.childSchedules({ from: "2026-09-30", to: "2026-09-11" })).rejects.toThrow();
    await expect(client.childSchedules({ childId: "child-a" } as never)).rejects.toThrow();
    await expect(client.childSchedules({ participantIds: ["child-a"] } as never)).rejects.toThrow();
    noChildren = true;
    expect(await client.childSchedules()).toEqual({ children: [] });
    expect(requests).toHaveLength(4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("separate processes serialize rotating credentials and logout waits for an in-flight request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abler-concurrency-"));
  const path = join(directory, "session.json");
  let current = cookie.value;
  let rotations = 0;
  let hold = false;
  let started!: () => void;
  let release!: () => void;
  const refreshing = new Promise<void>(resolve => { started = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/oauth/token") {
      if (!request.headers.get("cookie")?.includes(`refreshToken=${current}`)) return new Response(null, { status: 401 });
      current = `rotated-${++rotations}`;
      if (hold) { started(); await proceed; }
      const response = Response.json({ access_token: "access" });
      response.headers.append("Set-Cookie", "id_token=access; Path=/; Max-Age=600; HttpOnly");
      response.headers.append("Set-Cookie", `refreshToken=${current}; Path=/; Max-Age=3600; HttpOnly`);
      return response;
    }
    return Response.json({ data: { me: { id: "parent", displayName: "Parent" } } });
  } });
  const env = { ...process.env, ABLER_TEST_FILE: path, ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.port}` };
  const code = `import { AblerClient } from ${JSON.stringify(pathToFileURL(resolve("src/api.ts")).href)};
    const request = (url, init) => fetch(new URL(new URL(url).pathname, process.env.ABLER_TEST_ORIGIN), init);
    console.log(JSON.stringify(await new AblerClient(process.env.ABLER_TEST_FILE, request).status(true)));`;
  const run = () => Bun.spawn([process.execPath, "--eval", code], { env, stdout: "pipe", stderr: "pipe" });
  try {
    await saveSession(path, await importCookies([cookie]));
    const processes = [run(), run(), run()];
    const results = await Promise.all(processes.map(async p => ({ exit: await p.exited,
      out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
    expect(results.map(r => r.exit)).toEqual([0, 0, 0]);
    expect(results.every(r => JSON.parse(r.out).authenticated)).toBe(true);
    expect(results.every(r => r.err === "")).toBe(true);
    expect(rotations).toBe(3);
    hold = true;
    const active = run();
    await refreshing;
    const logout = Bun.spawn([process.execPath, "--eval", `
      import { removeSession } from ${JSON.stringify(pathToFileURL(resolve("src/auth.ts")).href)};
      const removal = removeSession(process.env.ABLER_TEST_FILE);
      console.log("started");
      await removal;`], { env, stdout: "pipe", stderr: "pipe" });
    const reader = logout.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("started");
    expect(await Bun.file(path).exists()).toBe(true);
    release();
    expect(await active.exited).toBe(0);
    expect(await logout.exited).toBe(0);
    expect(await Bun.file(path).exists()).toBe(false);
    expect((await readdir(directory)).length).toBe(0);
  } finally { release(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 15000);

test("unsafe session files, malformed pages, stalled cursors, and wrong events fail explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abler-validation-"));
  const path = join(directory, "session.json");
  try {
    await saveSession(path, await importCookies([cookie, { ...cookie, name: "id_token" }]));
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(loadSession(path)).rejects.toThrow("owner-only");
      await chmod(path, 0o600);
      await symlink(path, join(directory, "link.json"));
      await expect(loadSession(join(directory, "link.json"))).rejects.toThrow("symlink");
    }
    let page: unknown = { edges: [], pageInfo: { hasNextPage: true, endCursor: null } };
    const client = new AblerClient(path, (async () => Response.json({ data: { schedule: page, event: page } })) as typeof fetch);
    await expect(client.schedule()).rejects.toThrow();
    page = { edges: [{ node: {} }], pageInfo: { hasNextPage: false, endCursor: null } };
    await expect(client.schedule()).rejects.toThrow();
    page = { edges: [{ node: { ...eventBase, eventId: "event-a" } }], pageInfo: { hasNextPage: true, endCursor: "same" } };
    await expect(client.schedule({ after: "same" })).rejects.toThrow("did not advance");
    await expect(client.event({ eventId: "event-b", ageGroupId: "age-group" })).rejects.toThrow("different event");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed import retains a rotated candidate without overwriting the existing session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abler-import-"));
  const path = join(directory, "session.json");
  try {
    await saveSession(path, await importCookies([cookie]));
    const original = await readFile(path, "utf8");
    const source = join(directory, "cookies.json");
    await writeFile(source, JSON.stringify([cookie]), { mode: 0o600 });
    const preload = join(directory, "upstream.ts");
    await writeFile(preload, `globalThis.fetch = async url => {
      if (String(url).endsWith('/oauth/token')) {
        const response = Response.json({ access_token: 'access' });
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=600');
        response.headers.append('Set-Cookie', 'refreshToken=recovery-token; Path=/; Max-Age=3600');
        return response;
      }
      return Response.json({ errors: [{ message: 'recovery-token secret' }] });
    };`);
    const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", "auth", "import", source], {
      env: { ...process.env, ABLER_SESSION_FILE: path }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const error = await new Response(child.stderr).text();
    expect(error).toContain("candidate is retained");
    expect(error).not.toContain("recovery-token");
    expect(await readFile(path, "utf8")).toBe(original);
    const candidates = (await readdir(directory)).filter(name => name.endsWith(".pending"));
    expect(candidates).toHaveLength(1);
    const candidate = join(directory, candidates[0]!);
    expect((await stat(candidate)).mode & 0o777).toBe(0o600);
    expect(await (await loadSession(candidate)).getCookieString(ORIGIN)).toContain("refreshToken=recovery-token");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
