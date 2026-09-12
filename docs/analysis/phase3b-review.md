# Phase 3B adversarial review

Reviewed `ec2c619`, `eccd19d`, and `5607104` against `3627729`; source is at
`e175198`. This was an offline review. No live family, Abler, or InfoMentor
service was contacted.

## Findings

### P0 — every freshly compiled executable crashes before it can serve or print its version

**Evidence:** `packages/mcp-runtime/src/index.ts:104-107`, called at module
evaluation by `packages/abler-mcp/src/server.ts:18` and
`packages/infomentor-mcp/src/server.ts:27`.

`packageVersion(import.meta.url)` synchronously opens `../package.json`. In a
`bun build --compile` binary, `import.meta.url` resolves under `/$bunfs/root/`;
there is no adjacent host file. A fresh local compile of each CLI with Bun
1.2.19 built successfully, but both `--version` calls exited 1 with:

```
ENOENT: no such file or directory, open '/$bunfs/package.json'
```

**Failure scenario:** every released standalone binary evaluates its server
module before parsing CLI arguments, so `--version`, `--help`, auth commands,
and stdio startup all fail on a clean host.

**Suggested fix:** embed the version at bundle time (the previous static JSON
import is bundled by Bun), or pass it as an explicit build-time constant. Do
not derive package metadata from a bundle-relative filesystem path. Add a
fresh-compile `--version` smoke test; the checked-in ignored release binaries
are stale and did not exercise this source path.

### P1 — the shared error path still leaks tokens and arbitrary upstream text from Abler

**Evidence:** `packages/mcp-runtime/src/index.ts:32-47` and
`packages/abler-mcp/src/server.ts:20-23`.

`toolResult` only replaces HTTP(S) URLs. The Abler wrapper then deliberately
returns every unknown `Error.message` to the model. Thus an error such as
`refreshToken=secret-value; upstream body ...` reaches tool content unchanged;
only a URL contained in that message is replaced. The Zod path is safe, and
InfoMentor limits unknown errors to a fixed message, but the shared helper does
not provide the claimed all-path redaction for Abler. A direct local
`toolResult` call with that error returned the token/body text unchanged.

**Failure scenario:** an unexpected cookie, fetch-wrapper, or future upstream
handling error includes a raw `Set-Cookie`, bearer token, request body, or
non-URL endpoint text in its message. `auth_status`/schedule tools return it to
the model. The current test covers a URL only, not token/body patterns.

**Suggested fix:** make unknown-error output a fixed safe message. Only
allowlist messages from a dedicated safe error type; do not make regex
redaction the privacy boundary. Add tests for bare bearer/refresh-token values,
cookie headers, and a body without a URL.

### P2 — SIGINT/SIGTERM closes stdio but does not cancel an in-flight Abler operation holding the session lock

**Evidence:** `packages/mcp-runtime/src/index.ts:75-99`,
`packages/abler-mcp/src/api.ts:183-210`, and
`packages/abler-mcp/src/auth.ts:26-33`.

`startStdio` consumes either signal and closes the MCP handle, but it has no
per-server cancellation hook. Unlike InfoMentor, Abler has no client shutdown
handler. An Abler tool call owns `withSessionLock` while its fetch uses only an
independent 20-second timeout; closing stdio does not abort that fetch or
release the lock sooner.

**Failure scenario:** `auth_status` is waiting on a stalled Abler request when
the host sends SIGTERM. The transport closes, but the process can remain alive
and the session lock stays held until the request's timeout/settlement. A
second process sees the lock as busy; a hard stop can also leave its cleanup to
stale-lock recovery rather than graceful release.

**Suggested fix:** give `startStdio` an awaited shutdown hook (or arrange an
Abler server `onclose` hook) that aborts a lifecycle signal merged into every
Abler fetch, then waits for in-flight work before returning. Add a signal test
with an injected never-resolving fetch that asserts prompt exit and no lock or
temporary directory remains.

## Checks that held

- The six Abler result shapes match the fields requested by their GraphQL
  queries. `list_child_schedules` parses the full attendance row, filters by
  the selected child ID, then removes the player object; it does not narrow by
  display name. Unknown fields are intentionally stripped, as the phase report
  and test fixture state. No source evidence establishes that an actually
  nullable Abler field is rejected; live verification remains out of scope.
- Stretch #23 keeps account pinning: every `InfoMentorClient.read` first makes
  a fresh parent read and compares `currentUser.id` to the saved account
  (`packages/infomentor-mcp/src/client.ts:127-135`). Collection consumes that
  exact `http.parent` once, then resumes fresh parent reads and confirmation
  checks (`client.ts:238-256`, `collection.ts:324-424`). I found no path that
  treats a stale cached parent page as a new authentication check.
- The old Node integration test has 190 assertion calls; the Bun version has
  191. The injected-fetch migration preserves every old assertion (including
  the `nativeFetch` check, now `globalThis.fetch`) and adds the parent-read
  request-count assertion. No assertions disappeared.
- `5607104` changes no package source files, so its lint-debt cleanup does not
  disguise a runtime ordering, type, or `typeof` behavior change.
- Other than `packageVersion`, I found no bundle-relative runtime file lookup.
  The remaining filesystem paths are explicit host-local session, credential,
  import, lock, or collection-state paths; InfoMentor's static JSON manifest is
  bundled by Bun rather than read at runtime.

## Validation

`bunx turbo run test --force` passed: 5 packages successful (mcp-runtime 2,
Abler 9, InfoMentor 18, session-store 8, release tooling 1). This command does
not build a fresh standalone binary, which is why it did not expose P0.
