import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../src/server.js";

const executable = resolve(process.argv[2] || "dist/cli.js");
const directory = await mkdtemp(join(tmpdir(), "abler-installed-"));
const client = new Client({ name: "abler-package-check", version: "1.0.0" });
const node = Bun.which("node");
assert(node, "Node.js must be installed");
// The installed process gets Node on PATH, with no Bun or developer checkout tools.
await symlink(node, join(directory, "node"));
const env = { PATH: directory, ABLER_SESSION_FILE: join(directory, "missing.json") };
try {
  const version = Bun.spawn([executable, "--version"], { env, stdout: "pipe", stderr: "pipe" });
  assert.equal(await version.exited, 0);
  assert.equal((await new Response(version.stdout).text()).trim(), VERSION);
  const transport = new StdioClientTransport({ command: executable, env, stderr: "pipe" });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, VERSION);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["auth_status", "get_event", "get_profile", "list_child_schedules", "list_groups", "list_schedule"]);
  const status = await client.callTool({ name: "auth_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(JSON.stringify(status), /No saved Abler session/);
  const typo = await client.callTool({ name: "list_child_schedules", arguments: { childId: "misspelled" } });
  assert.equal(typo.isError, true);
  console.log(`Installed ${VERSION}: Node executable, MCP handshake, all six tools, missing auth, and strict child filters passed.`);
} finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
