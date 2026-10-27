# Opt-in whole-day sickness reports (native binary)

This unreleased change adds two tools to the **native release binary** only.
The legacy TypeScript reference implementation remains read-only. Nothing is
exposed by default; the existing seven read tools and optional setup tools are
unchanged. Start explicitly with:

```sh
infomentor-mcp serve --allow-absence-writes
```

The flag cannot be enabled by a tool call. Setup tools remain separately gated.
Enabling absence tools does not itself authorize any report to the school.

## Workflow

1. Read the overview and identify the human's intended child by its returned ID.
2. Call `infomentor_prepare_absence` with `childId` and `date` (`YYYY-MM-DD`).
   Only whole-day sickness for **today or tomorrow in UTC** is supported.
   Preparation selects that child, checks fresh options and saves a ten-minute
   preview locally; it does not send an absence.
3. Show the returned child, exact date and whole-day sickness scope to the human
   and get explicit approval to send that report through InfoMentor.
4. Call `infomentor_submit_absence` with the returned `operationId` and
   `confirm: true`. The tool reselects the preview's child, checks account,
   permissions, existing absences, locks, UTC date and expiry again, and attempts
   one JSON POST. It then reads fresh state to verify that InfoMentor reports the
   child absent for that date. This **does not establish school approval**.

There are no leave requests, reason/comment changes, cancellations, multi-day or
lesson-level writes. Existing partial/full absences and locked dates are refused,
not overwritten. Unsupported or incomplete upstream shapes fail closed.
Preparation and submission change the session's selected child. Use the overview
afterwards if another tool needs a particular selection.

## Unknown is not failure

A private `absence.json` beside the encrypted session record records `submitting`
**before** the single write. Network loss, error responses, redirects (including
same-origin 307/308), cancellation, or failed verification leave an uncertain
attempt. There is no authentication retry or redirect replay after sending.

An uncertain attempt blocks new previews for **all children**, across processes,
restart, logout and sign-in. A repeated operation ID returns its recorded outcome
without another write once normal authentication/rate-limit checks permit reading. A completed ID also returns its recorded verified result;
that is the earlier verification, not a claim that nobody later edited the record
at school. Re-preparing that completed child/date is refused.

Check InfoMentor and involve the operator to reconcile an uncertain attempt. Do
not delete, edit, move or reset the guard to permit another submission. There is
no automatic reset or agent-facing clear tool. A crash before the POST may also
leave an uncertain marker: caution is intentional.

The record is an atomic, owner-only (0600), regular **plaintext** file containing
the operation, parent/child IDs, child display name, date and state; no credentials
or cookies. It is private family data: do not copy it into logs, fixtures, issues,
or PRs. One record is shared by the installation, independent of `--session`.
It is not removed by logout. Corrupt, symlinked, shared or unreadable records block
writes. The account/session lock serializes the complete preflight, guard write,
submission and verification across local MCP clients.

The guard protects **one installation only**. Do not submit for the same account
from multiple machines or change storage locations to bypass it. Other upstream
clients can still change the server's selected child: because InfoMentor's observed
write API is session-context-dependent, avoid simultaneous child switching in
other apps sharing that session. Before/after parent checks narrow but cannot
atomically eliminate that upstream race.

## Contract evidence and verification limits

Read-only investigation on 2026-10-27 inspected the publisher's
[public client script](https://minn.infomentor.is/dist/scripts/scripts.js) and an
authenticated attendance app-data response. No real write was sent. No raw school
response or personal data is included here or in fixtures.

- The parent bootstrap advertises app code `attendance`.
- `POST /attendance/attendance/appData` is a read (empty form), returning
  `isParent`, `isIcelandic`, `canRegisterDayAbsence`, `urls.registerAttendance`,
  `absenceTodayDate`/`absenceTomorrowDate` (`dd.MM.yyyy`), `absentToday`/
  `absentTomorrow`, `absenceTodayLocked`/`absenceTomorrowLocked`,
  `canAddSicknessToday`/`canAddSicknessTomorrow`, per-day session arrays and
  `partOfDayAbsenceRegistrationsToday`/`partOfDayAbsenceRegistrationsTomorrow`.
- `IMHome.attendance.AbsenceReportingDayAndSession` constructs the full-day
  payload with `present: false`, `day: "today" | "tomorrow"`,
  `canAddSicknessToTimeRegistration` from that day's bootstrap flag, and
  `RegType: "day"`. `IMHome.core.postJSON` sends JSON, **not form fields**, with
  `Content-Type: application/json; charset=utf-8`.
- The observed destination is `/attendance/attendance/registerAttendance`.
  A changed destination is refused; upstream URLs never choose the write target.

Synthetic offline tests verify the native tools through real MCP stdio and a
loopback HTTP server, including the exact JSON contract, child selection,
permissions, duplicate/concurrent calls, expired previews, unknown outcomes,
redirects, authentication errors, process death, logout, and private-file checks.
**Live acceptance/persistence of a requested absence is not yet verified.**
The first live use must be a real, explicitly approved absence, never a fictitious
test; check the resulting record in InfoMentor as well as the tool's verification.
