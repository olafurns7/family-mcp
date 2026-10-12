# Frozen Abler parity cases: provenance

Each `<scenario>.json` here records what the TypeScript Abler CLI and server did in one scenario of
`tests/ts/parity.ts`, against that script's fake Abler. `tests/replay.rs::every_frozen_parity_scenario_replays`
replays every file through the binary. Once the TypeScript package is deleted, these files are the
contract. Nobody regenerates them.

- Source: `packages/abler-mcp/src`, `packages/session-store/src`, `packages/mcp-runtime/src` and
  `tests/ts/{parity,rewrite}.ts` at 41d6f98. They are unchanged on `feat/ts-retire-1d` (1a6ca95);
  only `packages/abler-mcp/CHANGELOG.md` differs.
- Bun: 1.4.2, on macOS (arm64).
- Generator, run from the repository root:
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 FAMILY_MCP_STORE_TEST_SEAM=1 bun tooling/ts-freeze/abler-parity.ts rust/abler-mcp/tests/fixtures/parity`
  A second run writes byte-identical files.
- Case ids: `abler/parity/<scenario>`, the 13 named parity.ts scenarios (`surface`, `no-session`,
  `tools`, ...) and one file per value of its two loops: `refresh-<mode>` (8) and `graphql-<mode>`
  (15), 36 files in all. `replay.rs` lists them all, and the ledger names them.
- Data: all synthetic. The cookies are the fake's `r0` and its rotations `r<N>`, the access tokens
  `a<N>` (`e<N>` after a 500), the export's `stale` and `GA1`. Every upstream answer comes from the
  fake in parity.ts. Each home was a scratch directory with the store test seam. Nothing reached
  Abler or the real store.

## How the TypeScript side ran

parity.ts ran each scenario twice, against the TypeScript CLI and server and against the binary,
each in its own home, with one fake, and compared the two runs. The freeze ran only the TypeScript
side, with the CLI and `tests/ts/rewrite.ts` preloaded, in parity.ts's environment (scratch `HOME`
and XDG folders, the store test seam, `ABLER_TEST_ORIGIN` at the fake). It added a temporary folder
`<home>.tmp` outside the home, so no run's temporary files reach the home's listing. MCP traffic
was raw newline-delimited JSON-RPC (protocol 2025-11-25, client `abler-parity`), with one `serve`
per step, as parity.ts ran them. Each answer is the line the server wrote.

parity.ts's `interop` check, where each language read the other's rotations from one home, is not
a scenario and has no fixture: once the TypeScript side is gone there is nothing to interoperate
with. The store format itself is frozen in `rust/family-store/tests/fixtures/store` (PR 1a).

## What each file records

- `id`, and `env`: the environment the scenario set besides the scratch folders.
- `steps`, one per line, in order:
  - `file`: a file parity.ts wrote (folders 0700; the file 0600, or `permissions`).
  - `mode`: the fake's mode (and `accessAge`, the access cookie's Max-Age) from then on. A replay
    ignores it, because the recorded exchanges carry the answers.
  - `cli`: arguments and standard input when given (none: an empty, closed input). It also records
    the exit code, stdout, stderr, and every upstream exchange of the run.
  - `serve`: `true`. For the surface scenario it also records the `initialize` and `tools/list`
    answer lines. Each call is a `[tool, arguments]` pair; for each call it records the
    notifications before the answer, the answer line, and the call's exchanges, then the server's
    exit code and stderr once its input closed.
- `requests`: the number of upstream requests in the scenario. There are 226 in all.
- `files`: every path left under the home with its mode, sorted. A folder ends in `/`.
- `texts`: the text of every file left under the home but the store's encrypted record
  (`.config/abler-mcp/session.enc`) and its key (`.local/share/family-mcp/keys/`), by path; a JSON
  text as its value, named as below, any other text as it is. The store marker is here.
- `store`: `"none"` when no record or marker exists; `record`: the decrypted session (`null` once
  logged out), named as below; or `error`: the store's error code.

An exchange is `{request, response}`:

- `request`: method, path with its query, the four headers parity.ts recorded (`cookie`,
  `accept`, `content-type`, `content-length`; `null` when absent), and the body.
- `response`: status, headers (no `date`, `connection`, `keep-alive`, `content-length` or
  `transfer-encoding`; `set-cookie` as an array), and body, raw.

Only Abler's two endpoints, `/oauth/token` and `/graphql`, were recorded, as parity.ts recorded
them; a loopback port scanner's request is neither recorded nor allowed to reach the replay's
script.

## Names

The freeze rewrote these values in outputs and in the stored and file texts. Requests and
responses stay raw. The replay rewrites the binary's the same way before comparing:

- the scratch home → `<home>`;
- in a JSON text, each cookie's `expires`: within 40 days of the scenario's start, `<now+Nks>` (or
  `<now-Nks>`), N its offset from the start in kiloseconds, rounded; otherwise `<at:S>`, S in
  whole seconds. Abler has no clock seam, so a cookie the fake sets with `Max-Age` expires relative
  to the wall clock. The fake's ages give 30 s → 0, 600 s → 1, 3600 s → 4 and 2592000 s → 2592; a
  replay would have to run minutes late to cross a rounding boundary. parity.ts compared the same
  expiries in 100 s steps relative to the time of comparison. The export's 2100 expiry, an expired
  cookie (0) and a session cookie (-1) stay absolute;
- in a JSON text, a candidate's random ID (a UUID under the key `id`) → `<candidate-id>`, where
  parity.ts compared its type only.

Long runs of one character inside a string are packed as U+0001, the character, `*`, the count,
U+0001. The replay expands the runs.

## What the replay allows, and what it relaxes

- **Nothing in the request list.** parity.ts compared the request lists whole, so each request
  must equal the recorded one whole, in order, and the count must match. The binary adds no
  request.
- **Key order.** parity.ts read `initialize` and `tools/list` through the SDK client, which rebuilds
  them in its schemas' key order, so only their values were ever compared. The replay compares
  their values too. A tool answer's key order is compared exactly.
- **What parity.ts did not compare and the replay does**: each request's method, each `serve`'s exit
  code and stderr, the whole home's listing with modes, the text of every file, and the store
  marker.
