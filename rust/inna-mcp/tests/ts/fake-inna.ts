// The fake nam.inna.is of parity.ts: one loopback server both sides reach through their test
// origin, answering the read endpoints with synthetic data that is either plain or odd (dates in
// every shape, markup, numbers JavaScript prints in its own way, unknown fields), switching
// students as Inna does, and answering any path with a planted failure. It records what each
// request carried that both sides must agree on.
import { createServer, type IncomingMessage } from 'node:http';

export type Planted = { status: number; headers?: Record<string, string>; body?: string };

export type State = {
  odd: boolean;
  selected: string;
  /** Switches that answer but change nothing. */
  ignoreSwitch: boolean;
  switchLocation: string;
  /** Failures by path, used in place of the answer. */
  planted: Record<string, Planted>;
  rotations: number;
};

export const fresh = (): State => ({
  odd: false,
  selected: '1',
  ignoreSwitch: false,
  switchLocation: 'http://nam.inna.is/Components/Students/Students.html',
  planted: {},
  rotations: 0,
});

export type Seen = { method: string; url: string; headers: Record<string, string | null>; body: string };

const COMPARED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'x-requested-by',
  'x-xsrf-token',
];

const permissions = {
  isGuardian: true,
  logInType: '2',
  olderThan18: false,
  registerAbsenceGuardian: '1',
  registerAbsenceUnder18: '0',
  registerAbsenceOver18: '1',
  registerAbsence: '1',
  student18RegisterAbsence: '1',
  registerLeave: '1',
  student18RegisterLeave: '1',
  registerIllnessTomorrow: '1',
};

const contexts: Record<string, object> = {
  '1': {
    userId: 1,
    studentId: '2',
    schoolId: '3',
    studentName: 'Synthetic student',
    name: 'Synthetic guardian',
    schoolLong: 'Synthetic school',
    defaultTermId: '4',
    ...permissions,
  },
  '5': {
    userId: 5,
    studentId: '6',
    schoolId: '8',
    studentName: 'Synthetic sibling 🦊 with a name that runs on'.padEnd(300, '·'),
    name: 'Synthetic guardian',
    schoolLong: 'Synthetic second school',
    defaultTermId: '4',
    ...permissions,
  },
};

const ORDER = ['1', '5', '9'];

const entries: Record<string, Record<string, unknown>> = {
  '1': { system: '1', status: '1', skoli_id: '3', skoli_heiti: 'Synthetic school' },
  '5': { system: 1, status: 2, skoli_id: 8, skoli_heiti: 'Synthetic second school', title: 7 },
  '9': { system: '2', status: '1', skoli_id: '3', skoli_heiti: 'Synthetic school' },
};

function access(state: State) {
  return ORDER.map((key) => ({
    ...entries[key],
    userId: key,
    loggedIn: key === state.selected ? '1' : key === '5' ? false : '0',
    nafn: key === '9' ? 'Synthetic staff' : `Synthetic name ${key}`,
    kennitala: '9999999999',
    url_login: 'https://nam.inna.is/auth/token?token=DO-NOT-RETURN',
  }));
}

const dates = [
  '02.01.2040',
  '2040-01-02',
  '2040-01-02T10:00:00',
  '2040-01-02T10:00:00.5+01:00',
  '2040-01-02 10:00',
  '02.01.2040 10:00:00',
  '31.02.2040',
  '2040-02-30',
  '1.1.2040',
  '',
  ' 02.01.2040 ',
  '0000-01-01',
  '29.02.2040',
  '29.02.2041',
  '24:00',
  '2040-01-02T24:00:00',
  '9999-12-31T23:59:59.999Z',
];

const pick = (index: number) => dates[index % dates.length]!;

const html =
  '<p>A &amp; B&nbsp;&lt;tag&gt;</p><style>hidden</style><script>hidden()</script><ul><li>one<li>two</ul>' +
  '<div>  x \t y </div><br>tail &#128512; &unknown; <a href="https://example.invalid/do-not-fetch">link</a>';

function feed(path: string, odd: boolean): unknown {
  const many = <T>(make: (index: number) => T) => (odd ? dates.map((_, index) => make(index)) : [make(0)]);

  switch (path) {
    case '/api/StudentTerms/GetStudentTerms':
      return [{ termId: '4', termCode: 'Synthetic term', extra: 1 }];
    case '/api/ModulesAndBooklist/GetModulesAndBooklist':
      return many((index) => ({
        moduleId: '1',
        moduleTermId: String(index + 2),
        moduleName: 'Synthetic module',
        moduleName2: '',
        subjectName: 'Synthetic subject',
        groupId: '7',
        groupName: 'Synthetic group',
        termId: '4',
        ...(index % 2 ? { booklist: [{ bookname: 'Synthetic book', isbn: 'x' }] } : {}),
        dateFrom: pick(index),
        dateTo: pick(index + 1),
        // A delivered `dates` is checked, then replaced in place.
        ...(odd ? { dates: { planted: { iso: '2040-01-02', status: 'parsed' } } } : {}),
      }));
    case '/api/Homework/GetStudentHomework':
      return many((index) => ({ id: index + 0.5, date: pick(index), moduleName: 'Synthetic', text: html }));
    case '/api/Announcements/GetStudentAnnouncements':
      return many((index) => ({
        announcementId: String(12 + index),
        date: pick(index),
        title: 'Synthetic announcement',
        sender: 'Synthetic school',
        ...(index % 3 ? { moduleName: 'Synthetic module' } : {}),
        contentHtml: html,
        hasOpened: index % 2 === 0,
      }));
    case '/api/Timetable/GetTimetable':
      return many((index) => ({
        start: pick(index),
        end: pick(index + 3),
        titleShort: 'Synthetic lesson',
        allDay: index % 2 === 1,
        // Not an integer from 2^53 up to 1e21: JavaScript writes its digits, the binary (as the
        // Krónan and InfoMentor binaries) an exponent or `.0` (browser_login::js::number).
        ...(odd ? { timetable_id: [1e21, -0, 0.1 + 0.2, 2 ** 53 - 1, 1.5e-7][index % 5] } : {}),
        teacher: 'Synthetic teacher',
      }));
    case '/api/GetAssignments/GetStudentAssignments':
      return many((index) => ({
        assignmentId: String(5 + index),
        name: 'Synthetic assignment',
        module: 'Synthetic course',
        type: String(index % 2),
        assignedFullDate: pick(index),
        handInFullDate: pick(index + 5),
        handedIn: index % 2 ? '1' : 0,
        isOpen: 1,
        projectId: '6',
        ...(index % 2 ? { exam: '1', weight: '20', assignmentComment: html } : {}),
      }));
    case '/api/GetAssignments/GetAssignmentInfo':
      return {
        assignmentId: '5',
        name: 'Synthetic assignment',
        description: odd ? html : '<p>Instructions</p><script>discard()</script>',
        moduleName: 'Synthetic course',
        groupId: '7',
        groupName: '1',
        moduleTermId: '8',
        returnDate: odd ? '2040-01-02T10:00:00' : '03.01.2040',
        type: 0,
        exam: 0,
        weight: '20',
        projectId: '6',
        groupReturnSize: odd ? 2.5 : 0,
      };
    case '/api/StudentGrades/GetStudentGrades':
      return many((index) => ({
        moduleTermId: '8',
        termId: '4',
        moduleName: 'Synthetic module',
        subjectName: 'Synthetic subject',
        units: '5',
        status: 'L',
        show: true,
        termCode: 'Synthetic term',
        ...(index % 2 ? { grade: '8.5', myUnits: '5', dateFinished: pick(index) } : {}),
      }));
    case '/api/GetAssignments/Groups/7/StudentProjects':
      return {
        assignments: many((index) => ({
          id: 5 + index,
          name: 'Synthetic assessment',
          type: 0,
          weight: odd ? 33.333 : 20,
          ...(index % 2 ? { grade: '8', commentByTeacher: html } : {}),
          returnDate: odd ? [0, 1, -1, 2208988800000, 253402300800000, 1.5][index % 6] : 1,
          assignDate: 1,
          handedIn: true,
        })),
        categories: [],
      };
    case '/api/Attendance/GetAttendance':
      return {
        absencesTotal: [{ code: 'F', name: 'Synthetic', number: '1' }],
        leaveOfAbsencesTotal: [],
        attendanceTerm: { realAttendance: '90', attendance: '95' },
        dateFrom: odd ? '2040-01-01' : '01.01.2040',
        dateTo: odd ? '' : '01.05.2040',
        termName: 'Synthetic term',
        nrClassesTotal: 10,
        absencePointsTotal: '1',
        modules: [
          {
            moduleName: 'Synthetic module',
            show: 1,
            studentRecordId: '3',
            attendance: odd ? {} : { realAttendance: '90', attendance: '95' },
            absences: [],
            leaveOfAbsence: [],
            absencePoints: { nrClasses: '10' },
          },
        ],
      };
    case '/api/Attachment/GetModuleFiles':
      return [
        {
          fileGroupId: '9',
          groupId: '7',
          fileGroup: 'Synthetic group',
          files: many((index) => ({
            name: 'Synthetic file',
            fileId: '10',
            closed: index % 2 === 0,
            link: 'https://example.invalid/do-not-fetch',
            ...(index % 2 ? { dateOpened: pick(index) } : {}),
          })),
        },
      ];
    case '/api/Messages/GetReceivedMessages':
      return { count: odd ? dates.length : 1, messages: many((index) => ({
        messagesId: String(11 + index),
        table: 'A',
        ...(index % 2 ? { title: 'Synthetic message' } : {}),
        sender: 'Synthetic sender',
        date: pick(index),
        ...(index % 3 ? { dateOpened: pick(index + 1) } : {}),
        status: 'S',
      })) };
    case '/api/Messages/GetMessageDetails':
      return {
        title: 'Synthetic message',
        message: odd ? html : '<p>Hello &amp; welcome</p>',
        dateCreated: odd ? '2040-01-02T10:00:00' : '02.01.2040',
        dateSent: odd ? '31.02.2040' : '02.01.2040',
        sentTo: 'Synthetic recipient',
        type: 'A',
        attachmentList: odd ? [{ attachmentId: 3 }, { attachmentId: '4', name: 'x', contentType: 'y' }, {}] : [],
      };
    case '/api/RegisterAbsence/GetRegisterAbsences':
      return {
        todayAllowed: true,
        tomorrowAllowed: odd,
        today: false,
        tomorrow: false,
        doctorsNote: '',
        comment: odd ? html : '',
      };
    case '/api/RegisterAbsence/GetLeaves':
      return many((index) => ({
        id: index + 1,
        dateFrom: pick(index),
        dateTo: pick(index + 1),
        leaveType: 'Synthetic',
        status: 'Synthetic',
        statusCode: 1,
        reasonForLeave: html,
        createdBy: 'Synthetic',
        ...(index % 2 ? { confirmedBy: 'Synthetic' } : {}),
        created: pick(index + 2),
        classes: [{ date: pick(index), timeFrom: '08:00', timeTo: '09:00', class: 'Synthetic' }],
      }));
    case '/api/RegisterAbsence/GetStudentRegisteredAbsences':
      return many((index) => ({
        id: index + 1,
        date: pick(index),
        ...(index % 2 ? { comment: html } : {}),
        statusCode: 0,
        allDay: '1',
        classes: [],
      }));
    default:
      return undefined;
  }
}

async function read(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
}

/** Starts the fake; `state` and `seen` are read at each request, so a run swaps them in place. */
export async function startFake(current: () => { state: State; seen: Seen[] }) {
  const server = createServer(async (request, response) => {
    const { state, seen } = current();
    const [, host = '', ...rest] = (request.url ?? '/').split('/');
    const url = new URL(`https://${host}/${rest.join('/')}`);
    const headers = Object.fromEntries(
      COMPARED_HEADERS.map((name) => [name, request.headers[name]?.toString() ?? null]),
    );
    seen.push({ method: request.method ?? '', url: url.href, headers, body: await read(request) });
    const send = (status: number, body: string, extra: Record<string, string | string[]> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...extra });
      response.end(body);
    };
    const planted = state.planted[url.pathname];

    if (host !== 'nam.inna.is') return send(404, '');

    if (planted) return send(planted.status, planted.body ?? '', planted.headers ?? {});

    if (url.pathname === '/auth/system') {
      const key = ORDER[Number(url.searchParams.get('i'))];

      if (key && !state.ignoreSwitch) state.selected = key;

      return send(303, '<html>Synthetic redirect</html>', {
        location: state.switchLocation,
        'set-cookie': `SESSION=synthetic-switched-${seen.length}; Path=/; Secure; HttpOnly`,
        'content-type': 'text/html',
      });
    }

    if (url.pathname === '/Components/Students/Students.html')
      return send(200, '<html>Synthetic application</html>', { 'content-type': 'text/html' });

    if (url.pathname === '/api/UserData/GetLoggedInUser') {
      state.rotations += 1;

      return send(
        200,
        JSON.stringify({
          ...(contexts[state.selected] ?? contexts['1']),
          access: access(state),
          studentIdNumber: 'DO-NOT-RETURN',
        }),
        { 'set-cookie': [`SESSION=synthetic-rotated-${state.rotations}; Path=/; Secure; HttpOnly`, 'other=x; Path=/'] },
      );
    }

    const body = feed(url.pathname, state.odd);

    // Inna pages messages by row, from 1.
    if (url.pathname === '/api/Messages/GetReceivedMessages' && body && typeof body === 'object') {
      const page = body as { messages: unknown[] };
      const from = Number(url.searchParams.get('rowFrom'));
      page.messages = page.messages.slice(from - 1, Number(url.searchParams.get('rowTo')));
    }

    return body === undefined ? send(404, '') : send(200, JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();

  if (!address || typeof address === 'string') throw new RangeError('No fake port.');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The private cookie export `auth import` reads. */
export const COOKIES = JSON.stringify(
  ['SESSION', 'XSRF-TOKEN'].map((name) => ({
    name,
    value: name === 'SESSION' ? 'synthetic-session' : 'synthetic-xsrf',
    domain: 'nam.inna.is',
    path: '/',
    secure: true,
  })),
);
