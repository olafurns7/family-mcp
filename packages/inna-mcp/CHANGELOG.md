# Changelog

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
