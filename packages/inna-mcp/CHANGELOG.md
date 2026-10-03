# Changelog

## 0.3.0

- `inna-mcp auth login --google` signs in with Google in one command. It opens
  a temporary Chrome or Chromium window on Inna's Google sign-in, waits for the
  student page, saves the verified session, and closes the window; nothing is
  copied or pasted. `--timeout <seconds>` (default 300) and `--browser <path>`
  or `INNA_BROWSER` are optional. It needs a desktop session. Checked offline
  against a fake browser; not yet run against Inna and Google.
- Cookie import is now documented as the fallback for a machine without a
  desktop.
- Electronic-ID login no longer stops when Inna lists several contexts. It
  signs in to the first student context, or to the already saved default
  student when a session exists, and that student is the default. The other
  students are reached with `inna_list_students`. `--allow-account-change`
  takes the first listed student as the new default. Login still stops when no
  accessible student context is listed.
- Switching between two students was confirmed on a real account by a user on
  2026-10-03: the list returned two keys and an overview read succeeded for the
  default student and the sibling. Absence submission and the effect of the
  keep-alive on session lifetime remain unverified.

## 0.2.2

- While `serve` runs, the server makes one small authenticated request every
  ten minutes so the saved session is not left idle. It saves rotated cookies,
  reads no school data, never switches students, waits out rate-limit pauses,
  and stops after Inna asks for sign-in until the saved session cookies change,
  as after a new login or import.
  `serve --no-keep-alive` turns it off. This only prevents an idle timeout;
  Inna's session lifetime is still unmeasured.
- A student switch that Inna answers with a sign-in request now reports
  "Inna refused the student switch and asked for sign-in" instead of the
  message used for an expired session on an ordinary read.

## 0.2.1

- Tools that accept `studentKey` are no longer annotated read-only, because a
  call can change Inna's selected student for the shared session. They still
  change no school record. `inna_list_students` and `inna_absence_status`
  stay read-only.

## 0.2.0

- Read several students under one saved session. The new `inna_list_students`
  tool returns each student's `studentKey`; the read tools and
  `inna_prepare_absence` accept it and default to the student saved at login or
  import. The server switches Inna's selected student per request and verifies
  the selection, user, school, and learned binding before and after each read.
- Session files are now version 2 and record the verified binding of each
  student read. Version 1 files are read and upgraded on the next use.
- A login or import that lands on another learned student is refused with
  guidance; replacing the default student forgets the learned students.
- Absence previews record their student, submission selects it without a
  `studentKey`, and `inna_absence_status` reports the operation of any student
  of the session without switching. One uncertain operation still blocks new
  previews for every student.
- Live switching between two students is unverified by the maintainer; the
  request is source-verified and covered by synthetic tests only.

## 0.1.1

- Normalize school dates explicitly as UTC, preserve date-only and raw values,
  and expose parsed/missing/unrecognized status plus retrieval timestamps.
- Continue inbox paging using delivered rows; reject incomplete, duplicate,
  and inconsistent pages. Recheck student context before returning reads.
- Preserve numeric and HTTP-date rate-limit pauses across restarts. Shared
  response-body reads now cancel stalled streams on abort; request deadlines
  also cover Inna response bodies.
- Check illness overlap for leave requests and refuse malformed absence dates,
  UTC midnight changes, or preview expiry during final submission checks.
- Exercise all 15 tools offline through MCP, multi-page inboxes, concurrent
  reads, timezone differences, response cancellation, and write refusal paths.

## 0.1.0

- Initial standalone native MCP for Inna school accounts.
- Electronic-ID login uses hidden phone input and approval on the phone. The
  CLI prints the security code before initiating verification; agents must show
  that exact code to the user. Google supports private browser-cookie import.
- Read timetable, assignments/homework, assessment, attendance, material
  metadata, messages, announcements, and absence history in a verified context.
- Whole-day illness and leave requests require opt-in, a private preview, and
  explicit approval. Account/permission checks and persisted operation markers
  prevent replay after uncertain outcomes. Live submission is unverified.
- Shared owner-only session storage, atomic replacement, and locking. No
  unattended renewal, partial-day absence, cancellation, or automatic school
  selection when multiple contexts are available.
