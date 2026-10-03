# Changelog

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
