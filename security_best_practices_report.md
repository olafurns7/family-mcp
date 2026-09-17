# Security best-practices review

Reviewed: 2026-09-17  
Repository: `family-mcp`  
HEAD: `d0906e0b09dc00d16ece4b93a68350aff3e5d69c`  
Scope: current working tree, including the untracked landing site/workflow, plus locally available reachable Git history.

## Executive summary

**All four findings are addressed in the working tree: two medium and two low.** The original review verified no critical or high-severity vulnerability. Both medium findings required local conditions; neither established an unauthenticated remote compromise of the default MCP servers.

The main protections are substantial: stdio transport, restricted upstream destinations, private session storage, account checks, sanitized MCP errors, bounded responses, and persistent payment replay prevention. Existing package/release tests passed. Additional adversarial probes confirmed the login weaknesses and passed the tested payment, account-binding, and input-validation cases.

No real committed credential was identified by the scoped secret scan. Both dependency audits reported no known vulnerabilities. Those results are bounded evidence, not a guarantee that every secret or vulnerability has been detected.

| ID  | Original severity | Fix                                                                                                                        | Status                                          |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | Medium            | Removed InfoMentor's password-collecting local HTTP form, browser launcher, CLI/MCP inputs, and obsolete waiting state     | Fixed; regression tests pass                    |
| 2   | Medium            | Abler file imports use the existing private-file reader; file and stdin inputs are limited to 4 MiB                        | Fixed; regression tests pass                    |
| 3   | Low               | Abler cookie parsing returns a fixed safe error; CLI prints only reviewed `SafeError` messages and uses a generic fallback | Fixed; regression tests pass                    |
| 4   | Low               | Ignore documented credentials/token filenames and `*.checkouts/` directories                                               | Fixed; positive and negative ignore checks pass |

## Remediation and validation (2026-09-17)

The authorized plan was to remove the unsafe optional handoff, reuse the existing credential-file protections, sanitize Abler's shared HTTP and CLI error boundaries, and extend the ignore rules. Two implementation workers were coordinated through Herdr with separate package ownership. The remediation pass changed no dependencies, versions, or release configuration. Version bumps and synchronized release artifacts were prepared in the separately authorized release follow-up.

InfoMentor retains private credentials-file/environment login, session import, automatic renewal, account binding, and cancellation. **Migration:** remove `--local-form` / `localForm` from old configurations, use a private credentials file or environment injection, restart upgraded MCP processes, and close any old form tabs. The `waiting` setup state is also removed. The CLI gives a fixed migration message; the strict MCP schema rejects the retired field, including `false`.

Abler rejects shared, linked, nonregular, and oversized source files before parsing or verification. Stdin is counted in bytes and excess input is rejected before concatenation. Valid exact-limit imports still verify the account, save privately, and retain the original export for user-controlled cleanup. Existing rotated-candidate recovery remains tested. Browser, capture, usage, and cleanup errors retain reviewed guidance while unknown exceptions stay out of terminal output.

| Verification                                                             | Result                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forced repository typecheck, lint, formatting, tests, and release checks | 34/34 Turbo tasks passed; 118 tests passed (89 server/runtime/storage, 25 lint-plugin, 4 release-tooling)                                                                                                                                                                      |
| Final affected-package tests                                             | Abler 31/31; InfoMentor 23/23; each package's typecheck, lint, and formatting passed                                                                                                                                                                                           |
| Native binaries and installers                                           | Abler and InfoMentor each passed all three build/binary/installer tasks on macOS arm64; native archives, standalone MCP, 12 mocked installer cases, process/truncation checks, real local-archive install/reinstall, checksum rejection, and prior-command preservation passed |
| Compiled input boundaries                                                | Four direct native checks rejected shared/linked/oversized Abler imports and the retired InfoMentor form flag without creating a session                                                                                                                                       |
| Independent offline probe                                                | Valid private import passed; shared/symlink/hard-link/oversized file and oversized stdin imports rejected before provider verification or session mutation; malformed cookie/Chrome errors sanitized; retired form flag rejected                                               |
| Ignore rules                                                             | Nine secret/cache paths ignored; six example/source paths remain visible                                                                                                                                                                                                       |
| Independent review                                                       | Separate reviewers examined the other worker's fixes for security, state integrity, maintainability, and regression quality; both found no actionable defect. Six focused Abler checks and nine InfoMentor checks passed; reviewed source hashes were stable                   |

The repository regression locations are `packages/abler-mcp/test/integration.test.ts:57`, `:127`, `:194`, `:231`, `packages/infomentor-mcp/test/integration.test.ts:376`, and `packages/infomentor-mcp/test/targeted.test.ts:59`. They cover the original failures and successful private authentication, not just type assertions. Existing browser cleanup and session/account tests also passed.

Reproduce the repository checks without contacting providers:

```sh
./node_modules/.bin/turbo run typecheck lint format:check test release:check --force
./node_modules/.bin/turbo run test:binary test:installer --filter=abler-mcp --filter=infomentor-mcp --force
```

Local fix evidence: `${TMPDIR}/family-security-fix-checks.log`, `${TMPDIR}/family-security-fix-native-abler.log`, `${TMPDIR}/family-security-fix-native-info.log`, and `${TMPDIR}/family-security-fix-probe.ts` / `.log`. The final Abler package run also included four additional assertions added after the repository run started; all 31 tests passed with 305 expectations. Temporary evidence is not a replacement for the repository's regression tests.

All verification used synthetic data and offline provider substitutes. These checks do not establish live provider behavior, hosted CI, other operating systems, or published release contents. At completion of the remediation pass, changes were local and uncommitted; nothing had been pushed, released, or deployed. The subsequently authorized releases are Abler 0.5.3 and InfoMentor 0.7.0; their package changelogs contain the upgrade notes. Preexisting landing-site and Android OAuth documentation work was preserved.

**Historical evidence below describes the pre-fix snapshot.** Its source line numbers and temporary vulnerability repro scripts refer to the original review; those scripts are not expected to reproduce the fixed behavior. The remediation section above records current status.

## Scope and method

The codebase primarily uses TypeScript on Bun 1.4.2, the MCP SDK, Zod, `tough-cookie`, and `htmlparser2`. The landing site is static Astro with browser JavaScript and CSS. Distribution uses shell scripts, Node release tooling, and GitHub Actions YAML. The local Oxlint plugin's execution sinks and package boundary were screened; this was not a correctness review of every lint rule.

Applied the requested `security-best-practices` skill and its general JavaScript frontend reference. The skill has no dedicated Bun/MCP/Astro backend reference, so backend assessment used direct source tracing, existing security tests, and adversarial probes. Two reviewers were orchestrated through Herdr: authentication/session handling, and commerce/MCP tools. The coordinating review covered release tooling, dependencies, history, the landing site, and independent reproduction of findings.

Reviewed boundaries included MCP arguments into requests, paths and payments; provider headers/JSON/HTML/redirects/errors into credentials and outputs; credential imports, permissions, links, persistence and locks; browser login and cleanup; installer downloads/extraction/process handling; CI permissions; and frontend DOM operations and configured security headers.

Provider access was mocked. No live accounts, provider mutations, or payments were exercised, and actual private credential stores were not read. Internet access was used for public security guidance/advisories and dependency audits.

## Critical and high severity

None verified within the reviewed scope.

## Medium severity

### 1. Stale local login form can submit credentials to a replacement process

**Rule:** authenticate the recipient throughout a secret handoff.  
**Locations:** `packages/infomentor-mcp/src/credentials.ts:86`, `:151`, `:190`; opt-in at `packages/infomentor-mcp/src/cli.ts:154`; five-minute default deadline at `packages/infomentor-mcp/src/login.ts:43`.

**Evidence:** the generated page contains a normal password form with `method="post" action="${path}"`. Cancellation or timeout closes the listener with `server.closeAllConnections()` and `server.close()`. The already-loaded page is not invalidated and retains the same destination.

**Attack conditions and impact:** a user explicitly enables the local form and leaves its page open after cancellation or expiry. Another process on the same machine discovers the port and binds it after release. If the user submits the stale page, its username/password body reaches the replacement listener. That listener can accept any path; the attacker need not know the random URL or CSRF token in advance. The original server's Host, Origin, CSRF, and CSP checks cannot protect a request received by another process.

**Verification:** an offline probe loaded the real generated HTML, cancelled `promptCredentials`, successfully bound another listener to the same port, and submitted the original form fields/action with synthetic credentials. The replacement listener received both fields. This was HTTP replay using real form markup, not an observed browser interaction or a separate-user OS test.

```text
originalListenerClosed: true
samePortRebound: true
victimFormUnmodified: true
syntheticCredentialsCaptured: true
```

**Minimal safe fix:** retire or disable the optional password-collecting loopback form and use the already-supported private credentials file or private environment injection. If browser UX is retained, it needs a handoff that remains tied to the original process. Another request-side token alone does not solve port takeover; merely delaying listener shutdown narrows the window.

**Immediate mitigation:** use the default private-file/environment login methods and close cancelled/expired forms. This is a local, nondefault flow defect, not a generic complaint about development HTTP or a remote CSRF bypass.

**Runnable evidence:** `bun ${TMPDIR}/family-security-form-cancel-repro.ts`.

### 2. Abler cookie-file import bypasses the shared private-file reader

**Rule:** validate ownership, permissions, file type, and size at credential-input boundaries.  
**Locations:** `packages/abler-mcp/src/cli.ts:130`–`:137`; safe helper at `packages/session-store/src/files.ts:62`; protected saved-session loading at `packages/abler-mcp/src/auth.ts:144`.

**Evidence:** `auth import FILE` uses `readFile(argument, 'utf8')`. Its stdin alternative also accumulates input without a bound. The existing `readPrivateFile` helper rejects shared permissions, foreign ownership, symlinks, hard links, special files, and oversized data, but this path does not call it.

**Attack conditions and impact:** if an export is placed in a directory accessible to another local user, overly permissive permissions expose live authentication cookies; a writable source can be replaced with another account's valid credentials before import. Symlink/hard-link inputs are accepted too. Verification proves the imported account works, not that an unsafe export was protected or unchanged. The newly saved session being mode 0600 does not repair or remove the source. Credential validity after refresh depends on provider rotation semantics.

**Verification:** with provider requests replaced by synthetic responses, the actual CLI imported a mode-0666 export, a symlink to it, and a hard link successfully. The shared private reader rejected the same source. No real cookie was used.

```text
sourceMode: 666
safeReaderRejected: true
writableImportExit: 0
symlinkImportExit: 0
hardlinkImportExit: 0
```

**Minimal fix:** use `readPrivateFile` with an explicit browser-export size limit for file imports, and bound stdin input. Reject unsafe files before verification/persistence; do not silently chmod or follow a supplied link. Preserve cookie validation and account verification.

**Immediate mitigation:** use an owner-only directory and a regular single-link mode-0600 export; remove it after successful import as already advised at `packages/abler-mcp/README.md:164`. This is a local input-boundary failure, not a remotely exposed file-read tool.

**Runnable evidence:** `bun ${TMPDIR}/family-security-auth-repro.ts`.

## Low severity

### 3. Abler CLI exposes unreviewed upstream/library error text

**Rule:** return fixed, reviewed errors across external-data boundaries.  
**Locations:** `packages/abler-mcp/src/api.ts:235`–`:240`; `packages/abler-mcp/src/cli.ts:156`–`:158`. Contrast the MCP boundary at `packages/mcp-runtime/src/index.ts:67`.

**Evidence:** an upstream `Set-Cookie` for an accepted authentication cookie reaches `jar.setCookie`. Domain-validation errors from `tough-cookie` escape that operation. The CLI prints `error.message` for every `Error`, rather than only reviewed safe errors.

**Verification:** a synthetic response containing an invalid cookie Domain with a unique marker caused `auth status` to print that marker to stderr. This proves untrusted response data enters terminal/log output. It does **not** establish that a real password or cookie value leaked. A separate malformed-CDP-JSON probe did not disclose the complete response marker.

**Impact and prerequisites:** an unusual or attacker-influenced provider response can enter logs through dependency exception text. Future dependency errors could include more context than intended. Normal MCP calls already use a sanitized boundary; this finding is limited to CLI handling.

**Minimal fix:** translate cookie-processing failures into a fixed `SafeError` at the shared Abler HTTP boundary. Make the CLI print only reviewed safe errors; convert intended local usage/configuration errors accordingly and use a generic fallback for unknown failures.

**Runnable evidence:** `bun ${TMPDIR}/family-security-auth-repro.ts`.

### 4. Ignore rules miss documented credentials and payment-cache files

**Rule:** prevent accidental inclusion of local secrets in source control.  
**Locations:** `.gitignore:11`–`:21`; `packages/dominos-mcp/src/client.ts:123`; `packages/dominos-mcp/src/schemas.ts:373`–`:377`; documented names at `packages/infomentor-mcp/README.md:193` and `packages/kronan-mcp/README.md:28`, `:57`.

**Evidence:** the ignore list covers `.env`, session/cookie JSON, pending files, and temporaries. It misses `credentials.json`, `kronan-token.json`, `token.txt`, and `session.json.checkouts/<uuid>.json`. Checkout records contain payment-session data, saved-card identifiers, and order details. Mode 0600 does not prevent the owning developer's Git process from staging them.

**Verification:** this read-only check printed only `session.json`; the remaining paths were not ignored:

```sh
git check-ignore --no-index --stdin <<'EOF'
session.json
session.json.checkouts/11111111-1111-4111-8111-111111111111.json
credentials.json
kronan-token.json
token.txt
EOF
```

**Impact and prerequisites:** a developer must put a credential source or supported override path inside the checkout and then stage it. Default XDG storage stays outside the repository. No actual committed leak was found. This is preventive hardening, not evidence of exposed payment credentials.

**Minimal fix:** extend the existing ignore section to cover the documented private filenames and `*.checkouts/`, retaining explicit exceptions for examples if necessary. Keep secrets outside the checkout. Ignore rules do not remove already-tracked content and do not replace scanning; GitHub documents history scanning in its [secret-scanning guidance](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning).

## Protections verified and exclusions

| Area                | Evidence and result                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP exposure        | All four servers use shared stdio startup (`packages/mcp-runtime/src/index.ts:100`). No HTTP MCP listener was found. InfoMentor's optional credential form is a separate temporary loopback service.                                                                                                                             |
| Session storage     | `packages/session-store/src/files.ts:62` checks permissions, owner, links, size, and mutation during reads; `:145` writes private temporaries before atomic replacement. Storage/lock/process tests passed. Finding 2 is a caller bypass.                                                                                        |
| Abler browser login | `packages/abler-mcp/src/browser-login.ts:619` uses inherited debugging pipes and an isolated profile. Browser lifecycle tests passed. Explicit `auth capture` is a separate, intentional loopback-CDP flow.                                                                                                                      |
| InfoMentor          | HTTPS destinations are validated (`packages/infomentor-mcp/src/session.ts:66`); redirects are checked per hop and cross-origin credential POST forwarding is rejected (`packages/infomentor-mcp/src/http.ts:122`). Setup tools are opt-in (`packages/infomentor-mcp/src/server.ts:125`). Renewal/account/selection tests passed. |
| Commerce            | Fixed provider origins, rejected redirects, strict schemas, masked card outputs, and account/amount/payment-session binding. Nine extra probes passed, including concurrent payments and restart after ambiguous results.                                                                                                        |
| Installers          | Download/redirect protocols and checksum verified at `tooling/release/install.sh.template:136`; named members extracted to new files at `:145`. All four mocked installer suites passed.                                                                                                                                         |
| Build and CI        | Native builds disable dotenv/bunfig autoload (`tooling/release/build-binary.mjs:56`). Actions are commit-pinned; ordinary CI has read-only repository permissions (`.github/workflows/ci.yml:10`). Release input is validated before draft creation (`.github/workflows/release.yml:24`).                                        |
| Landing             | Static Astro output and local assets; no credential entry or dynamic HTML sink found. Updates use `textContent` (`apps/landing/src/components/Landing.astro:119`). Security headers/CSP are configured (`apps/landing/public/_headers:2`); deployed delivery was not verified.                                                   |

`confirm: true` and tool annotations are not independent proof of human approval. The documented model delegates consent to the trusted MCP host; an automatically approving host can submit that field itself. No bypass of implemented account/amount/replay controls was found. The [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) places human confirmation in the application interaction model. Untrusted school/merchant text remains data, as this repository already documents.

SDK advisories were checked for applicability. The [HTTP transport/session advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7) and [HTTP DNS-rebinding advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w) do not establish an exploit against these stdio entrypoints.

The installer checksum verifies integrity against the GitHub release source; it is not an independent publisher signature. Compromise of that trusted release source is outside the checksum's protection. No separate provenance/signature mechanism was assumed.

## Original review validation results

| Check                        | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Forced Turbo package tests   | 9/9 tasks successful; 86 tests passed across six runtime/server/storage packages, zero failures                           |
| Package breakdown            | Abler 27; InfoMentor 24; Krónan 12; Domino's 8; session-store 14; MCP runtime 1                                           |
| Release tooling tests        | 4/4 passed                                                                                                                |
| Installer adversarial suites | Four packages each passed 12 piped-installer cases plus process-handling and truncated-script checks                      |
| Commerce/MCP probes          | 9 passed, including 12 concurrent clients producing exactly one order and one payment attempt                             |
| Authentication probes        | Findings 1–3 reproduced offline using synthetic data                                                                      |
| Root dependency audit        | No known vulnerabilities reported; 104 packages checked                                                                   |
| Landing dependency audit     | No known vulnerabilities reported; 375 packages checked                                                                   |
| Secret scan                  | 701 historical text blobs across 113 reachable commits; 262 current non-ignored text files; no real credential identified |

Commerce probes also covered account switching, wrong amounts, missing/false consent, invalid card aliases, injected payment fields, payment HTTP 401 without replay, payment-session amount/currency/ID/expiry mismatch, selecting a second card, cross-account refresh, path traversal, unexpected upstream fields, and oversized response cancellation.

The secret scan searched private-key headers, recognizable provider tokens, JWTs, and literal credential assignments. Eighty-four candidate assignment matches across history/current files were confined to synthetic fixtures and documentation placeholders. No private-key/provider-token/JWT pattern matched. No tracked file with the screened credential-dump/key filenames was found. This was a custom pattern scan, not Gitleaks/TruffleHog or proof against arbitrary unrecognized secrets. Ignored private stores, unreachable Git objects, hosted logs/artifacts, and repository security settings were not scanned.

Reproducible primary commands:

```sh
./node_modules/.bin/turbo run test --force \
  --filter=abler-mcp --filter=infomentor-mcp --filter=kronan-mcp \
  --filter=dominos-mcp --filter=@family-mcp/session-store \
  --filter=@family-mcp/mcp-runtime
node --test tooling/release/release.test.mjs
for package in abler-mcp infomentor-mcp kronan-mcp dominos-mcp; do
  node tooling/release/installer-test.mjs --package "packages/$package" --mode fake
done
bun audit
(cd apps/landing && bun audit)
bun ${TMPDIR}/family-security-auth-repro.ts
bun ${TMPDIR}/family-security-form-cancel-repro.ts
bun ${TMPDIR}/family-commerce-security-repro.ts
```

Temporary evidence on this machine: `${TMPDIR}/family-security-package-tests-turbo.log`, `${TMPDIR}/family-security-release-tests.log`, `${TMPDIR}/family-security-installer-*.log`, `${TMPDIR}/family-security-secret-scan.py`, `${TMPDIR}/family-security-secret-scan.json`, and `${TMPDIR}/family-security-reviewed-files.json`. Temporary scripts/logs may be cleaned by the OS; they are not committed regression tests. The scan JSON suppresses matched values.

An initial direct `bun test ... packages` run from the repository root was interrupted because Abler fixtures need package-local working directories. The reported passing run used the normal Turbo runner. A reviewer's initial sandboxed loopback tests encountered bind restrictions and passed after unchanged reruns with local access. Neither invocation issue is counted as a product defect.

## Limits and follow-through

This is source review plus offline evidence for the identified snapshot. It does not certify live upstream authorization, payment completion, bank-verification/3-D Secure continuation, published native archives, hosted CI/deployment, or every OS. WARP installation was inspected and exercised through mocks; no administrator installation or live tunnel was performed. Local-form evidence is an HTTP replay, not browser or cross-user execution proof.

Existing dirty changes in `README.md` and `packages/infomentor-mcp/docs/HTTP-AUTH.md`, and untracked `.agents/`, `.claude/`, `apps/`, `skills-lock.json`, and `.github/workflows/landing.yml`, predated the review. Application source remained unchanged during the original review; the authorized follow-up fixes are summarized above.

The remediation follow-up implemented all four recommended fixes and added focused regressions. The maintainer subsequently authorized committing all repository changes and publishing the two affected MCP releases.
