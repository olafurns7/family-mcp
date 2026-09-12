# Findings

### [P2] Include shared runtime sources in consumer cache keys — turbo.json:11

The cached `test`, `typecheck`, and `lint` tasks have no dependency edges or inputs covering the shared workspace packages. After a successful run, changing `packages/session-store/src` or `packages/mcp-runtime/src` can therefore replay an old success for both servers, even though their tests, types, and type-aware lint consume the changed source. In a disposable copy of this HEAD, changing both shared entrypoints changed the shared packages' task hashes but left all six server task hashes unchanged. Add the relevant dependency task edges or shared-source inputs. The required `--force` validation bypasses this defect; ordinary `bun run check` and `bun run test` do not.

### [P2] Apply the login deadline while waiting for the session lock — packages/infomentor-mcp/src/lock.ts:22

The new 30-second lock wait receives only the caller's optional signal. `login()` creates its `timeoutMs` deadline inside `createAuthenticatedHttp()`, after acquiring that lock. Consequently, `login --timeout 1` can wait approximately 30 seconds, then begin authentication after the advertised maximum wait has elapsed. An offline reproduction held the lock past a 50 ms login timeout: the first injected HTTP request started at approximately 386 ms, and `LOGIN_TIMEOUT` arrived at approximately 436 ms. Previously, contention failed immediately. Establish the deadline before acquiring the lock and carry the remaining deadline through authentication and the session commit.

### [P2] Bound the upstream cooldown before serializing it — packages/infomentor-mcp/src/login.ts:193

The new persistence path converts `http.rateLimitedUntil` directly to an ISO date, but HTTP `Retry-After` parsing accepts finite durations beyond JavaScript's date range. A synthetic 429 with `Retry-After: 9999999999999` makes `InfoMentorClient.getOverview()` throw `RangeError: Invalid Date` from `saveActive()` in `finally`, replacing the intended `RATE_LIMITED` error. Neither the cooldown nor any cookies rotated by that response are saved. Two fresh clients sharing the same file consequently both contact the injected upstream. Apply the existing one-hour bound before conversion/persistence; the clamp in `rateLimitCooldown()` runs only when loading a successfully saved date and cannot prevent this failure.

### [P2] Describe the family data actually returned to the MCP host — README.md:139

The security section promises that school/sports data is never returned as MCP tool output. Successful tools intentionally return children's identities, schedules, school messages, and other requested family data: `packages/mcp-runtime/src/index.ts:27` emits the result in both text content and `structuredContent`. A parent using this statement to assess a host's access is given an incorrect privacy guarantee. Restrict the non-disclosure promise to credentials and other authentication secrets, and explicitly explain that requested school/sports data is delivered to the configured MCP host. This finding concerns the documented success-path boundary, separately from the excluded unknown-error issue.

### [P3] Replace the removed build and distribution-test commands — packages/infomentor-mcp/README.md:485

Both package READMEs still prescribe `turbo run build ...` followed by `turbo run test:dist ...`, although the native-only migration removed both task names. The same commands occur at `packages/abler-mcp/README.md:222`, and its smoke-test description still names `test:dist` at line 261. Running the InfoMentor commands with `--dry=json` fails immediately with “Could not find task `build` in project” and then the equivalent error for `test:dist`; none of the requested checks can run. Use the supported source checks followed by `test:binary test:installer`, matching the root instructions.

### [P3] Remove the unsupported package-import instructions — packages/infomentor-mcp/README.md:468

The updated library-compatibility guidance still advertises a consumable TypeScript package and accompanies `import { InfoMentorClient } from 'infomentor-mcp'`. The native-only manifest now has no `main`, `types`, or `exports`, there is no distribution build, and the supported installer supplies an executable. Even resolving that package name from this installed workspace fails with `ERR_MODULE_NOT_FOUND`. Remove the public-library example and compatibility promise, or explicitly present it as development against checkout source with a working source import. Restoring npm distribution is unnecessary and contrary to the requested distribution scope.

### [P3] Synchronize the root installation pins during a version bump — tooling/release/sync-version.mjs:18

Version synchronization considers only paths relative to the selected package, leaving the primary install commands in the repository root README untouched. In a disposable copy, bumping Abler from `0.3.1` to `0.3.2`, running `sync-version`, and then running its `--check` all succeeded while the root README still selected `abler-mcp@0.3.1`. Following the documented release procedure therefore leaves the main installation entrypoint on an older release without a check failure. Include the selected package's root README URLs in synchronization and validation, while preserving the other package's independent version.

## Assessment

Reviewed the changes from `0647ae9` through `2fa3a844181e905df5250f3f8443ec6764419490` on 2026-09-12, including shared storage/runtime code, both server integrations, workspace tooling, release scripts/workflows, tests, and documentation. HEAD remained unchanged during the review. The four issues expressly excluded by the brief are omitted from the findings above. There are no additional P0 or P1 findings.

The source checks pass, and the migration has useful protections: private bounded file reads, atomic session replacement, shared locking, account verification, restricted redirect handling, schema validation, and offline installer tests. The additional defects concern verification reliability, deadline and cooldown behavior, and instructions that no longer match the native-only distribution. The current HEAD does not have passing native acceptance: the required command stops at the already-known compiled-version defect before either native smoke suite runs.

Release source review found explicit package/tag checks, pinned action revisions, read-only default workflow permissions, a separately scoped draft-release write permission, and validation of the expected package-specific archive/checksum set. Installer source validates downloads before switching the installed command and extracts named archive members. These are source observations, not evidence that hosted release jobs or public installation URLs currently work.

## Validation performed

All HTTP reproductions used injected synthetic responses or loopback fixtures. No live Abler or InfoMentor service, real login, public release download, or administrator action was used. Temporary probe copies were removed. This report is the only repository file changed; no commit was created.

| Check | Result and scope |
| --- | --- |
| `bunx turbo run typecheck lint format:check test --force` | **Passed:** 20/20 tasks, no cached results. The default executable was Bun 1.2.19; Node was 24.12.0 and Turbo was 2.10.12. |
| `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test --force` | **Passed:** all five test tasks under pinned Bun 1.4.2. Totals: runtime 2, session-store 8, Abler 9, InfoMentor 18, release tooling 1; 38 top-level tests. |
| `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test:binary test:installer --force` | **Failed:** Abler's build-time executable version check raised `ENOENT` for `/$bunfs/package.json`, corresponding to brief exclusion (a). Turbo reported 0/2 build tasks successful. Neither downstream smoke suite ran; InfoMentor's concurrent build did not produce completed acceptance evidence. |
| `bunx turbo run release:check --force` | **Passed:** both packages' generated installers and currently covered documentation pins match their manifests. This does not cover the root README omission above. |
| `node tooling/release/installer-test.mjs --package packages/abler-mcp --mode fake` and the equivalent InfoMentor command | **Passed:** both packages' synthetic installer cases, including the reported 12-case matrix and truncation check. Fake executables and local curl substitutes were used; these passes do not substitute for real native installation. |

Required-check logs are available locally at `/private/tmp/family-mcp-astra-review-checks.log` and `/private/tmp/family-mcp-astra-review-native.log`. The pinned-runtime test log is `/private/tmp/family-mcp-astra-review-pinned-tests.log`.

The findings were also grounded with these targeted offline probes:

- **Cache invalidation:** archived the exact reviewed HEAD into a temporary directory, recorded `turbo run test typecheck lint --dry=json`, changed only the two shared source entrypoints there, and compared the second dry run. Server dependencies were empty and their hashes stayed identical. For example, Abler's test hash remained `49dc3134bb388005` and InfoMentor's remained `698258a8e8f0b175`; the shared task hashes changed.
- **Login contention:** held the same session lock while invoking `login({ timeoutMs: 50, ... })` with private synthetic credentials and a signal-aware delayed fetch. Released the lock after the requested deadline and verified that the first HTTP request still began afterwards, followed by `LOGIN_TIMEOUT`.
- **Cooldown serialization:** supplied a synthetic saved cookie and the oversized numeric `Retry-After` response to two independent client instances. Both rejected with `Invalid Date`, both reached the injected fetch, and the session file acquired no cooldown.
- **Documentation commands and imports:** used Turbo dry runs to verify that the two documented task lists cannot resolve, and Bun module resolution to verify that the documented package-name import has no entrypoint.
- **Version synchronization:** changed only the package version in a temporary archived copy, ran synchronization and its check, and inspected the root README. The package pins advanced while the root pin did not.

## Test gaps

- **Consumer cache invalidation has no regression check.** Forced acceptance runs cannot expose an incorrect cache key. A small shared-source edit should invalidate the dependent server test/typecheck tasks without `--force`.
- **The login deadline test starts with a free lock.** `packages/infomentor-mcp/test/integration.test.ts:1181` verifies cancellation of an in-flight request. It does not cover a shorter login deadline expiring during the newly introduced lock wait.
- **The cooldown tests miss the serialization boundary.** `test/targeted.test.ts:21` tests an HTTP date approximately five seconds ahead. The persistence test exercises a normal integer header and a pre-existing valid ISO date ten days ahead. Neither supplies an upstream duration outside the serializable date range. Its “other processes” case creates another client in the same process; it proves file-based reload behavior, not an actual second-process cooldown handoff.
- **The setup cancellation fixture does not reach the commit point it claims to test.** At `packages/infomentor-mcp/test/integration.test.ts:963`, the comment says only the storage commit check can prevent replacement. However, `selection.onParent()` runs inside the injected fetch before it returns the response, so request/body cancellation checks can reject earlier. The shared storage test at `packages/session-store/test/files.test.ts:91` does directly exercise its pre-rename abort check. The remaining gap is an adapter-level assertion that the setup path passes cancellation through to that boundary, not absence of a low-level commit test.
- **Abler's new schemas lack complete successful MCP round trips.** Group/event success fixtures call `AblerClient` directly; the stdio test covers tool enumeration, missing authentication, and invalid inputs. The tests do not demonstrate all six successful tool results passing the SDK's output-schema validation. Upstream optional/null fields are represented by synthetic fixtures only; no schema incompatibility with real upstream data was established in this review.
- **Native acceptance remains blocked.** Re-run both requested native suites after the known build defect is fixed. A source MCP test or synthetic installer pass does not verify a newly compiled binary's startup, SDK transport behavior, packaged notices/assets, or operation outside the checkout.

## Residual risks and evidence limits

- Hosted Actions, the four-platform native matrix, public download URLs, release permissions in execution, and published artifacts were not verified. Historical phase reports describe earlier commits and do not establish native acceptance for this HEAD. Dependency advisory queries were not run offline.
- Native SDK compatibility with actual MCP hosts, including older protocol negotiation and opt-in setup-tool transport behavior, remains outside the completed native evidence. Source inspection alone is insufficient to declare those host combinations accepted.
- The local storage contract coordinates cooperating processes sharing one host-local session path. It does not coordinate independent session copies, other hosts, or upstream applications changing selected-child/session state. Permission checks also do not isolate a malicious process already running as the same user. No additional cross-user exploit was established beyond the explicitly excluded work.
- No live upstream schema, authentication lifetime, real account renewal, challenge flow, or school/sports response was sampled. WARP administrator behavior and Debian daemon recovery were not exercised; the fake installer substitutes those commands. Windows and musl are outside the advertised native platform set.
