# Inna MCP investigation — 2026-10-02

Investigation used the owner's existing signed-in Chrome account, Chrome's native
DevTools Network panel with **Keep log**, the application's delivered JavaScript,
and an isolated HTTP client with cookies held in memory. No live absence request,
assignment submission, message send, or school-record edit was made. No credentials,
identity numbers, student IDs, phone numbers, raw payloads, or authentication token
values are included here.

## Authentication

The public [Inna page](https://www.inna.is/) offers Ísland.is, Google, Office, and
password sign-in. This investigation covers electronic ID and Google.

### Google — successful browser sign-in

1. `GET https://r.inna.is/auth/google` initiates Google's authorization flow.
2. Google's account chooser uses Inna's own OAuth client, `response_type=code`,
   `scope=openid email`, and `access_type=offline`.
3. The callback is `GET https://r.inna.is/auth/google/callback`, with `state`,
   `iss`, `code`, `scope`, `authuser`, `hd`, and `prompt` parameters observed.
4. The authenticated access page is `https://r.inna.is/adgangur`.
5. The selected school context passes through
   `GET https://nam.inna.is/auth/token?token=…&A=…&s=…&kt=…`, then
   `/auth/system?system=…&user_id=…&i=…&status=…`, and finishes at
   `/Components/Students/Students.html#/`.

The owner linked their Google account in Inna during this investigation. Before
linking, Google consent completed but Inna refused sign-in because the Google
account was unlinked. After linking, a fresh Google sign-in reached the Inna
dashboard. Registration of an email address in Inna did not by itself establish
a linked Google sign-in identity.

Chrome displayed internal HTTP-to-HTTPS upgrades in the legacy school handoff.
A direct client must upgrade these known `nam.inna.is` destinations to HTTPS
before making the request. Never transmit an identity number or login token over
HTTP, and never disable TLS verification.

Google sign-in belongs in Google's browser UI. The observed request asks for
offline OAuth access; this does not establish that a Google refresh token is
available to an MCP client. No Google credential or refresh token was captured
for storage. A browser-assisted CLI must preserve the complete redirect chain,
check the final Inna context, and obtain the school-session cookies through a
private transport rather than exposing a debugging port or tokens in MCP inputs.

### Electronic ID — complete native phone-prompt login verified

The owner approved fresh phone requests. The compiled native CLI completed the
HTTP flow, verified the final Inna account/student/school, and saved a private
school-cookie session through the shared session-store helpers. A separate
native process verified that saved session. No browser cookies were used for
the phone-prompt login.

| Step | Request | Observed contract |
| --- | --- | --- |
| Start | `GET https://r.inna.is/auth/island` | Redirect to `heimdallur.inna.is/auth/island/login` with `client` and `application-id`. |
| Inna identity broker | `GET https://heimdallur.inna.is/auth/island/login` | Redirect to `innskra.island.is/connect/authorize`; fresh state and PKCE S256 challenge; callback `https://heimdallur.inna.is/auth/island/callback`. |
| Authorization | `GET https://innskra.island.is/connect/authorize` | `client_id`, `response_type=code`, `scope=openid profile`, `state`, `redirect_uri`, `code_challenge`, `code_challenge_method`, and `prompt`; redirect to `/app/login?ReturnUrl=…`. |
| Context | `GET /login/context?returnUrl=…` on `innskra.island.is` | `clientName`, `identityProviderRestrictions`, `useApp2App`; sets CSRF cookies. |
| Phone bootstrap | `GET /login/phone?returnUrl=…` | `displayCode`, opaque `verificationProperties`, nullable `defaultRedirectUrl`. |
| Device check | `POST /login/phone/check-device` | JSON `{returnUrl, userIdentifier}`; returns `isTwoFactorRequired`, `rememberDevice`, `isNewLoginRestricted`. |
| Begin phone approval | `POST /login/phone/authenticate` | JSON `{returnUrl, verificationProperties, userIdentifier}`; returns `{userIdentifier, session}`. **Polling uses the nested `session`, not the outer response.** |
| Poll | `POST /login/phone/poll` | JSON session object; returns the next session. Pending responses were HTTP 200 with `isSuccess: false`. |
| Complete | `POST /login/phone/signin` | JSON `{session}` after `isSuccess: true`; HTTP 200 returned `validReturnUrl` and `validUserIdentifier`. Identity cookies were set only in the in-memory jar. |
| Authorization callback | `GET /connect/authorize/callback` on the issuer | Redirect to `heimdallur.inna.is/auth/island/callback` with code, scope, state, and session-state parameters. |
| Identity callback | `GET https://heimdallur.inna.is/auth/island/callback` | Redirect to the issuer's `/connect/endsession`, then `/logout?logoutId=…`. This is part of the successful handoff. |
| Provider logout | `GET https://innskra.island.is/logout?logoutId=…` | HTML anchor `a.PostLogoutRedirectUri`; delivered `signout-redirect.js` navigates to it. A non-browser client follows only the verified Heimdallur logout callback. |
| Logout callback | `GET https://heimdallur.inna.is/auth/island/logout-callback?state=…` | Redirect to **`https://inna.is/auth/island/callback?token=…&state=…`**, without `www`. |
| Inna access token | `GET https://inna.is/auth/island/callback?token=…&state=…` | Server-delivered HTML embeds an Inna JWT for the access page. The CLI extracts the opaque quoted token without executing JavaScript or decoding identity claims. |
| School access | `GET https://inna.is/auth/access` | Bearer-authenticated array; selected fields `system`, `user_id`, `status`, `is_access`. A Google browser capture verified the equivalent `r.inna.is/auth/access` with empty `callback_url` and `callback_system`. |
| Existing terms | `GET https://inna.is/auth/user-terms-confirmed` | Bearer-authenticated `{confirmed}`; CLI stops if false and never calls the terms-acceptance endpoint. |
| School selection | `POST https://inna.is/auth/system?i=…&system=…&user_id=…&status=…` | Bearer auth, JSON `{}`; returns `{url}` for the `nam.inna.is/auth/token` handoff. CLI supports exactly one accessible context and stops when school selection is ambiguous. |
| School cookies | Known `nam.inna.is/auth/token`, `/auth/system`, student application | Upgrade legacy HTTP destinations to HTTPS before requesting. Final school session is verified using `GetLoggedInUser` before atomic saving. |

The session object includes `isSuccess`, `retryWaitTime`, `retries`, `nexusUrl`,
opaque `data`, `timeoutErrorMessage`, `isFirstPoll`, `scriptId`, `sessionId`, and
`deviceLinkUrl`. Fields observed as null remain nullable. Respect the returned
poll interval and the challenge deadline. A terminal failure returned HTTP 400
with `errorMessage`, `secondaryMessage`, and `noReset`; never print upstream error
text directly or silently restart verification.

JSON requests send `Content-Type: application/json` and
`X-CSRF-TOKEN-IDS` copied from the `CSRF-TOKEN-IDS` cookie. Both
`X-CSRF-TOKEN-IDS` and `CSRF-TOKEN-IDS` cookies were set by the provider. The
delivered client URL-encodes `returnUrl` for the JSON request body; preserve the
fresh value rather than constructing OAuth state or challenges manually.

The CLI takes the phone number through hidden terminal input, displays
the provider's comparison code before authentication initiation, and polls while
the owner verifies on their phone. Any agent running the CLI must immediately
show the exact code to the user, including leading zeros, before waiting for
approval. The PIN is entered only on the phone. The live native check used an
isolated private session path; identity tickets and bearer tokens were not
persisted. Devices requiring additional authentication or login
restrictions must stop with an actionable safe error, rather than skipping them.

## School-session boundary

The data application is [nam.inna.is](https://nam.inna.is/). Its observed cookies
were:

| Cookie | Scope | Attributes observed |
| --- | --- | --- |
| `SESSION` | `nam.inna.is`, `/` | Session cookie, Secure, HttpOnly, SameSite Lax. |
| `JSESSIONID` | `nam.inna.is`, `/` | Session cookie, Secure, HttpOnly. |
| `XSRF-TOKEN` | `nam.inna.is`, `/` | Session cookie readable by the application; Secure was not set in the browser metadata. |

API requests send the cookie jar, `X-XSRF-TOKEN`, and
`X-Requested-By: XMLHttpRequest`. A successful
`GET /api/UserData/GetLoggedInUser` establishes the account, selected student,
school, default term, role, and permissions. It also contains identity numbers,
contact details, and opaque access links that must be removed from ordinary
tool output. The initial implementation returns an explicit limited context and
refuses a changed user/student/school binding. It never follows the `access`
array's `url_login` links. Later work selects among the listed students; see
[Student switching](#student-switching).

No long-term session lifetime or unattended cookie/OAuth renewal was established.
Inna issues only the `SESSION`, `JSESSIONID`, and `XSRF-TOKEN` browser cookies;
no refresh token exists. `serve` repeats this request every ten minutes as a
keep-alive, which can only prevent an idle timeout. Whether Inna has an idle
timeout, an absolute lifetime, or both is still unmeasured.
Save only verified sessions using the shared private session store, under the
shared file lock. Treat redirects, access denial, rate limits, malformed JSON,
and missing records distinctly; never return a failed feed as an empty list.

### Student switching

Added after the 0.1.1 release. `GetLoggedInUser` carries an `access` array with
one entry per application context of the signed-in person. A keys-only live
check on a one-student guardian account (values not recorded) established:

- Entry keys: `adgangur`, `isStudent`, `kennitala`, `loggedIn`, `nafn`,
  `notandi_id`, `skoli_audk`, `skoli_heiti`, `skoli_id`, `status`, `system`,
  `tegund`, `title`, `url_login`, `userId`, `virkur`, and
  `showPersonalInfoConfirmationModal`. There is no `id` key.
- `system`, `status`, `userId`, `skoli_id`, `loggedIn`, `isStudent`, `virkur`,
  `adgangur`, `notandi_id`, and `kennitala` are digit strings; `title`, `nafn`,
  `tegund`, `skoli_heiti`, and `skoli_audk` are strings;
  `showPersonalInfoConfirmationModal` is a boolean.
- For the selected entry, `userId` equals the top-level numeric `userId`,
  `skoli_id` equals `schoolId`, `skoli_heiti` equals `schoolLong`, and `nafn`
  equals `studentName`: `nafn` is the student's name. `isStudent` is `"1"`
  even for a guardian login, so it does not distinguish roles.
- `url_login` is a tokenized `nam.inna.is/auth/token` link. It must never be
  followed, stored, or returned; neither are `kennitala` and `notandi_id`.

`system` 1 is the student application. Other systems (0, 2, 3, 4) are other
Inna applications and are never switch targets.

The delivered student bundle switches the selected student with a plain
navigation, also seen in one two-student user's capture (values redacted):

```text
GET https://nam.inna.is/auth/system?i=<n>&system=<system>&status=<status>&user_id=<userId>
```

- `<n>` is the entry's index in the current `access` array; the other three
  values come from that entry.
- The request carries the session cookies only: no body, no `Authorization`,
  no `X-XSRF-TOKEN`, and no `X-Requested-By`.
- It answers 303 to `/Components/Students/Students.html`, which answers 200
  HTML. The `Location` may be an `http://` URL; upgrade `nam.inna.is` to HTTPS
  and never request HTTP. Afterwards the session cookie points at the other
  student and `GetLoggedInUser` returns the new context.

The client addresses a student by `studentKey`, the decimal `userId` of its
system-1 entry, and recomputes the index from a fresh `GetLoggedInUser` on each
call. It follows at most five hops, only to `/auth/system` or the student
application on `https://nam.inna.is`; any other redirect is treated as sign-in
required. After a switch it requires the target to be the only selected
system-1 entry, the returned `userId` to equal the key, and `schoolId` to equal
the entry's `skoli_id`, then compares the account/student/school binding with
the one learned on the first verified read. The dashboard's `GetUserOptions`
and `SetUserOptions` calls are not reproduced. Numeric fields are parsed as
digit strings or integers.

This is source-verified from the delivered bundle plus one user capture. The
maintainer has not verified live switching between two students; the
implementation is covered by synthetic tests only.

## Read endpoints

All paths below are on `https://nam.inna.is`. IDs must be discovered from this
account's responses; query strings in this report contain no live identifiers.
The listed endpoints returned HTTP 200 in the observed context unless stated
otherwise. Empty responses verify the endpoint, not every possible row shape.

| Area | GET endpoint and parameters | Response / behavior |
| --- | --- | --- |
| Identity/permissions | `/api/UserData/GetLoggedInUser` | Current account/student/school and capability flags. |
| Terms | `/api/StudentTerms/GetStudentTerms` | Array of `termId`, `termCode`. |
| Current terms | `/api/StudentInformation/GetStudentCurrentTerms` | `termId`, `divisionName`, `termCode`. |
| Courses/booklist | `/api/ModulesAndBooklist/GetModulesAndBooklist?termId=` | Course/module/group/term IDs, names, dates, and booklist. |
| Course details | `/api/ModulesAndBooklist/GetModuleInfo?groupId=…` | Course and term metadata, teachers, and booklist. |
| Timetable | `/api/Timetable/GetTimetable` | Parameters: `staff_id`, `student_id`, `moduleId`, `classroom_id`, `class_id`, `groupId`, `terms`, `date_from`, `date_to`, `attendanceOverview`. Dates use `dd.MM.yyyy`; unrelated filters were empty. Array of lessons/events. |
| Assignments/exams | `/api/GetAssignments/GetStudentAssignments?type=…&control=0&order=0` | Dashboard filters, `type=0` assignments, `type=1` exams. Names, due/assigned dates, weights, IDs, submission/open flags. Not a historical archive. |
| Course assignments | `/api/GetAssignments/GetStudentAssignmentsGroup?groupId=…&type=…&control=0&order=0` | Course-specific assignment/exam list. |
| Assignment details | `/api/GetAssignments/GetAssignmentInfo?assignmentId=…` | Description, due date, course IDs, weights, and exam/submission settings; direct read verified. |
| Homework | `/api/Homework/GetStudentHomework?groupId=&type=1&control=0&order=0` | Array with `id`, date, module name, text, and upstream pupil reference. |
| Homework checks | `/api/Homework/GetCheckedHomework?groupId=` | Existing completion references. Listing does not toggle them. |
| Weekly homework | `/api/Homework/GetHomeworkGoalsByDates?dateFrom=…&dateTo=…&groupId=…` | Returned an empty array in the selected course/week. |
| Course grades | `/api/StudentGrades/GetStudentGrades?termId=…` | Current observed rows contained course/status/unit fields but no published final mark. Missing marks are unavailable. Historical grade variants still need capture. |
| Assignment assessment | `/api/GetAssignments/Groups/{groupId}/StudentProjects` | `assignments` with numeric IDs, names, weights, optional grade and teacher comment, epoch dates, and `handedIn`; also a categories array. |
| Midterm evaluation | `/api/StudentMidtermEvaluation/GetStudentMidtermEvaluation?date_from=…&date_to=…&termId=…` | Returned `{}` in this context; nonempty shape unverified. |
| Attendance | `/api/Attendance/GetAttendance?termId=&type=0` | Term percentages, raw absence/leave codes and totals, per-module percentages and points. Preserve source codes. |
| Recent absences | `/api/Absences/GetStudentTeacherAbsences` | Returned an empty array. |
| Announcements | `/api/Announcements/GetStudentAnnouncements` | IDs, sender, date, title, HTML content, module, `hasOpened`. |
| Course announcements | `/api/Announcements/GetAnnouncementByGroupId?groupId=…` | Course announcement feed. |
| Materials | `/api/Attachment/GetModuleFiles?groupId=…&isStudent=1` | File groups and metadata; files may contain file IDs, link, description, `closed`, `dateOpened`, and content type. |
| New materials | `/api/Attachment/GetStudentNewFiles` | File/module/group IDs, metadata, and `hasOpened`. |
| External course links | `/api/ExternalLinks/GetExternalLinksByGroupId/{groupId}` | Returned an empty array; do not visit links automatically. |
| Teaching plan | `/api/TeachingPlan/GetTeachingPlan?groupId=…` | Creator, name, creation time, attachment ID/content type. |
| Old exams | `/api/TeachingPlan/GetPastExamsByGroup?groupId=…` | Returned an empty array. |
| Teachers | `/api/GroupTeacher/GetGroupTeacher?groupId=…&settings=7` | Teacher name, abbreviation, email, user ID, pronoun. |
| Exam timetable | `/api/Timetable/GetStudentExamSchedule?studentId=…` | Read endpoint observed from the course overview. |
| Inbox | `/api/Messages/GetReceivedMessages?dateFrom=&dateTo=&rowFrom=1&rowTo=21` | `{count, messages}`; rows include `messagesId`, `table`, subject, sender, date, opened date/status. Inclusive paging needs boundary verification on a larger feed. |
| Message detail | `/api/Messages/GetMessageDetails?messageId=…&type=…` | Plain/HTML message, title, dates, recipient text, and attachment list; direct read verified on an already opened message. |
| Unread count | `/api/Messages/GetNumberOfUnreadMessages` | `{count}`. |
| Illness options | `/api/RegisterAbsence/GetRegisterAbsences` | `todayAllowed`, `tomorrowAllowed`, `today`, `tomorrow`, `doctorsNote`, `comment`. |
| Registered illness | `/api/RegisterAbsence/GetStudentRegisteredAbsences?dateFrom=…&dateTo=…` | Nonempty history verified in the native read check; `id`, `date`, `allDay`, `statusCode`, `classes`, optional `comment`. |
| Leave history | `/api/RegisterAbsence/GetLeaves?getDateFrom=…&getDateTo=…` | IDs, creation/decision metadata, date range, type/status/code, reason, per-lesson classes. |
| Pending leave | `/api/RegisterAbsence/GetLeaves?status=0` | Returned an empty array. |
| Short leave context | `/api/RegisterAbsence/GetLeaves?getDateFrom=…&getDateTo=…&type=2` | Returned an empty array. |
| Weekly overview | `/api/WeeklyOverviews/{groupId}/isVisible`, `/api/WeeklyOverviews/{groupId}` | Visibility returned 200; selected course overview returned 204. Do not turn 204 into invented content. |

The delivered final-grade template accesses `grade`, `myUnits`, and
`dateFinished`. These optional fields are source verified; the current observed
API rows omitted them. Their nonempty historical response remains a capture gap.

The live native reads also verified sparse variants: school-wide announcements
can omit `moduleName`, course records can omit `booklist`, assignment `handedIn`
can be a string or number, per-course attendance percentages/points can be
absent, illness history can omit comments, and inbox rows can omit a subject.
Preserve these missing values as unavailable; do not manufacture empty text or
zero grades/attendance.

Additional dashboard reads included user options, unread/error/warning/info text,
photo, to-do items, surveys, forum overview, course-choice availability, and
equipment availability. They are outside the first MCP's useful school-data scope.
Sent/archive messages, study-record course/term histories, per-lesson attendance,
downloads, and nonempty midterm evaluations need further scoped capture before
claiming support.

## Side effects and absence writes

Opening a message in Inna's UI calls a separate
`/api/Messages/MarkMessageAsRead` operation when required. The delivered message
controller invokes `GetMessageDetails` first. The MCP calls only the detail read;
it does not reproduce the subsequent mark-read request. An unopened-message
before/after comparison remains a live verification gap. Likewise, material
opening and announcement viewing have separate mark-open/read paths. Listing
metadata avoids those operations. The dashboard itself makes
`POST /api/Options/SetUserOptions`, so full browser navigation is not proof that
the MCP's direct reads have the same incidental writes.

Both whole-day illness and leave use the delivered client's
`POST /api/RegisterAbsence/AddNewLeave`:

```json
{
  "firstDay": "dd.MM.yyyy",
  "lastDay": "dd.MM.yyyy",
  "leaveStatus": 0,
  "leaveType": 1,
  "allDay": 1,
  "comment": "the explicitly approved reason"
}
```

- `leaveType=1`: illness; the current UI permits today and, when configured,
  tomorrow, with one whole-day request per date.
- `leaveType=3`: whole-day leave/vacation application with an inclusive range.
- `leaveType=2`: short leave; the UI derives the day/range from selected lessons.
- Partial-day illness or short leave additionally creates individual lesson
  records through `POST /api/RegisterAbsence/AddTemporaryAbsence`, using `fId`,
  `date`, `startClock`, `endClock`, `titleShort`, `today`, `maintableId`,
  `timetableId`, and `studentRecordId`.
- Deletion/update paths exist but are outside the first MCP: the illness UI
  reuses `AddNewLeave` with existing/deleted fields; leave deletion uses
  `DELETE /api/RegisterAbsence/DeleteApplication`.

The UI expects an `id` in the successful creation response. This payload and
response contract are source verified, not live submission verified. The first
implementation supports whole days only, with write tools absent unless the
owner explicitly starts `serve --allow-absence-writes`. Prepare a private preview
bound to account/student/school and exact dates/kind/reason; submit only after
explicit approval to send that data to the school. Recheck permissions and
overlapping records, persist a submitting marker before POST, and never replay
an uncertain outcome. A returned creation ID is submission, not school approval.

## Release and verification status

The published 0.1.0 preview passed TypeScript, Oxlint, formatting, and ten
offline synthetic integration tests. The compiled Bun 1.4.2 native executable
also completed a stdio MCP handshake from an isolated directory without a
runtime on `PATH`: 13 tools by default and 15 with absence writes enabled,
declared output schemas, safe missing-session behavior, clean protocol output,
and no ambient `.env`/`bunfig.toml` preload. The owner-approved native phone login
also verified private session creation and reuse after process restart. A
separate restarted native MCP process exercised all 13 read/status tools against
the live session, including nonempty illness history and an already-opened message.
No successful school write or long-term session lifetime was established.

The [0.1.0 preview release](https://github.com/olafurns7/family-mcp/releases/tag/inna-mcp%400.1.0)
is published. Its release CI passed on macOS arm64/x64 and Linux arm64/x64;
the public installer was also checked against the downloaded CI-built binary.
The following hardening changes are included in 0.1.1, whose publication and
website update were authorized by the maintainer. Release and deployment
evidence is recorded in the [hardening verification report](inna-mcp-hardening.md).

### Date parsing and repeated reads

The owner confirmed that school dates and times are UTC. The delivered timetable
UI also uses `moment.utc`; its assessment date model constructs JavaScript dates
directly from numeric values, establishing milliseconds rather than seconds.
The client now preserves source fields and supplies normalized date metadata:
ISO UTC timestamps, unchanged date-only semantics, and explicit missing or
unrecognized states. Calendar and clock validation reject impossible dates,
overflowing times, ambiguous formats, and trailing junk. Timestamp normalization
was checked in three host timezones; no host-local interpretation is used.

The delivered message controller continues from the actual received-message
count plus one. The client now returns `nextRowFrom` using delivered rows and
rejects empty nonterminal, duplicate, overlong, and count-inconsistent pages.
Synthetic tests cover a 41-message feed with 20/20/1 delivered rows. A live
large-feed boundary and inbox changes during multi-call paging remain gaps;
these row offsets do not provide an atomic snapshot or stable cursor.

Each read verifies the selected context before and after data retrieval and
returns a UTC retrieval timestamp. Concurrent reads share the existing private
session lock; synthetic checks verify serialization and fresh fetches without
writes. HTTP-date and numeric rate-limit pauses survive a new client process
and expire at the stored deadline. Stalled streams now stop on cancellation,
and the request deadline includes the response body. An unavailable response
never becomes an empty feed.

Absence checks now validate complete history date strings, check illness overlap
for leave as well as sick requests, and refuse submission when the UTC day
changes or the preview expires during checks. All 15 tools round-trip through
the MCP protocol offline. Separate checks cover confirmed whole-day sick and
inclusive leave payloads. Real school writes remain unverified and require approval of
an actual requested absence. No fictitious request was sent.

The hardened package passes 21 synthetic tests with 1,865 assertions, plus the
shared response-body cancellation and byte-limit checks. See the
[hardening verification report](inna-mcp-hardening.md) for the final local gates.

Run the package's repeatable offline checks with:

```sh
bun run --cwd packages/inna-mcp check
bun run --cwd packages/inna-mcp test
bun run --cwd packages/inna-mcp build:binary
```

1. Verify historical final-grade shapes, mixed
   timetable events, message attachment variants, and paging boundaries.
2. With the owner's approval of an actual student/date/reason, verify one real
   absence write and reconcile its returned ID with history. Do not create a
   fictitious illness or leave request merely to test the endpoint.
3. Verify longer session lifetime and expiry behavior. One live restart/reuse
   check does not establish unattended authentication or renewal. The
   ten-minute keep-alive is unverified against a live session: measure whether
   it extends a session, and whether a lost session follows idle time or a
   student switch, which now report different errors.
4. Repeat native release gates and obtain maintainer approval for subsequent
   releases. Publication of 0.1.1 has been authorized; see its verification report.
