# Changelog

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
