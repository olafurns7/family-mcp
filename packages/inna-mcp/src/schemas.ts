import { Parser } from 'htmlparser2';
import { z } from 'zod';

export const id = z.string().regex(/^\d+$/).max(32);

export const date = z.iso.date();

export const dateRange = z
  .object({ dateFrom: date, dateTo: date })
  .strict()
  .refine((value) => value.dateFrom <= value.dateTo, 'Dates must be in order.');

export function innaDate(value: string): string {
  const [year, month, day] = date.parse(value).split('-');

  return `${day}.${month}.${year}`;
}

export function plainText(html: string): string {
  let text = '';
  let hidden = 0;

  const parser = new Parser({
    onopentag(name) {
      if (name === 'script' || name === 'style') hidden += 1;

      if (!hidden && ['br', 'p', 'div', 'li', 'tr'].includes(name)) text += '\n';
    },
    ontext(value) {
      if (!hidden) text += value;
    },
    onclosetag(name) {
      if (name === 'script' || name === 'style') hidden -= 1;

      if (!hidden && ['p', 'div', 'li', 'tr'].includes(name)) text += '\n';
    },
  });

  parser.end(html);

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const userSchema = z.object({
  userId: z.number().int().positive(),
  studentId: id,
  schoolId: id,
  studentName: z.string(),
  name: z.string(),
  schoolLong: z.string(),
  defaultTermId: id,
  isGuardian: z.boolean(),
  logInType: z.string(),
  olderThan18: z.boolean(),
  registerAbsenceGuardian: z.string(),
  registerAbsenceUnder18: z.string(),
  registerAbsenceOver18: z.string(),
  registerAbsence: z.string(),
  student18RegisterAbsence: z.string(),
  registerLeave: z.string(),
  student18RegisterLeave: z.string(),
  registerIllnessTomorrow: z.string(),
});

export const contextSchema = userSchema.pick({
  userId: true,
  studentId: true,
  schoolId: true,
  studentName: true,
  name: true,
  schoolLong: true,
  defaultTermId: true,
  isGuardian: true,
});

export const bindingSchema = userSchema.pick({ userId: true, studentId: true, schoolId: true });

export type User = z.infer<typeof userSchema>;

export type Binding = z.infer<typeof bindingSchema>;

export const termsSchema = z.array(z.object({ termId: id, termCode: z.string() }));

const bookSchema = z.object({ bookname: z.string() });

export const coursesSchema = z.array(
  z.object({
    moduleId: id,
    moduleTermId: id,
    moduleName: z.string(),
    moduleName2: z.string(),
    subjectName: z.string(),
    groupId: id,
    groupName: z.string(),
    termId: id,
    booklist: z.array(bookSchema).optional(),
    dateFrom: z.string(),
    dateTo: z.string(),
  }),
);

export const timetableSchema = z.array(
  z.object({
    start: z.string(),
    end: z.string(),
    titleShort: z.string(),
    allDay: z.boolean(),
    moduleId: z.string().optional(),
    groupId: z.string().optional(),
    moduleTermId: z.string().optional(),
    startClock: z.string().optional(),
    endClock: z.string().optional(),
    teacher: z.string().optional(),
    classroom: z.string().optional(),
    group: z.string().optional(),
    timetable_id: z.number().optional(),
    maintable_id: z.number().optional(),
    studentRecordId: z.number().optional(),
  }),
);

export const assignmentsSchema = z.array(
  z.object({
    assignmentId: id,
    name: z.string(),
    module: z.string(),
    type: z.string(),
    weight: z.string().optional(),
    assignedFullDate: z.string(),
    handInFullDate: z.string(),
    handedIn: z.union([z.number(), z.string()]),
    isOpen: z.number(),
    projectId: z.string(),
    exam: z.string().optional(),
    assignmentComment: z.string().optional(),
  }),
);

export const assignmentSchema = z.object({
  assignmentId: id,
  name: z.string(),
  description: z.string(),
  moduleName: z.string(),
  groupId: id,
  groupName: z.string(),
  moduleTermId: id,
  returnDate: z.string(),
  type: z.number(),
  exam: z.number(),
  weight: z.string(),
  projectId: z.string(),
  groupReturnSize: z.number(),
});

export const homeworkSchema = z.array(
  z.object({
    id: z.number(),
    date: z.string(),
    moduleName: z.string(),
    text: z.string(),
  }),
);

export const gradesSchema = z.array(
  z.object({
    moduleTermId: id,
    termId: id,
    moduleName: z.string(),
    subjectName: z.string(),
    units: z.string(),
    status: z.string(),
    show: z.boolean(),
    termCode: z.string(),
    grade: z.string().optional(),
    myUnits: z.string().optional(),
    dateFinished: z.string().optional(),
  }),
);

export const courseGradesSchema = z.object({
  assignments: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      type: z.number(),
      weight: z.number(),
      grade: z.string().optional(),
      commentByTeacher: z.string().optional(),
      returnDate: z.number(),
      assignDate: z.number(),
      handedIn: z.boolean(),
    }),
  ),
});

const totalsSchema = z.array(
  z.object({ number: z.string().optional(), code: z.string(), name: z.string() }),
);

const attendanceRate = z.object({ realAttendance: z.string(), attendance: z.string() });

export const attendanceSchema = z.object({
  absencesTotal: totalsSchema,
  leaveOfAbsencesTotal: totalsSchema,
  attendanceTerm: attendanceRate,
  dateFrom: z.string(),
  dateTo: z.string(),
  termName: z.string(),
  nrClassesTotal: z.number(),
  absencePointsTotal: z.string(),
  modules: z.array(
    z.object({
      moduleName: z.string(),
      show: z.number(),
      studentRecordId: id,
      attendance: attendanceRate.partial(),
      absences: totalsSchema,
      leaveOfAbsence: totalsSchema,
      absencePoints: z.object({ nrClasses: z.string(), absencePoints: z.string().optional() }),
    }),
  ),
});

export const materialsSchema = z.array(
  z.object({
    fileGroupId: id,
    groupId: id,
    fileGroup: z.string(),
    files: z.array(
      z.object({
        name: z.string(),
        fileId: z.string().optional(),
        fileName: z.string().optional(),
        contentType: z.string().optional(),
        description: z.string().optional(),
        link: z.string().optional(),
        closed: z.boolean(),
        dateOpened: z.string().optional(),
      }),
    ),
  }),
);

export const messagesSchema = z.object({
  count: z.number().int().nonnegative(),
  messages: z.array(
    z.object({
      messagesId: id,
      table: z.string().regex(/^[A-Z]$/),
      title: z.string().optional(),
      sender: z.string(),
      date: z.string(),
      dateOpened: z.string().optional(),
      status: z.string(),
    }),
  ),
});

export const messageSchema = z.object({
  title: z.string(),
  message: z.string(),
  dateCreated: z.string(),
  dateSent: z.string(),
  sentTo: z.string(),
  type: z.string(),
  attachmentList: z.array(
    z.object({
      attachmentId: z.union([z.string(), z.number()]).optional(),
      name: z.string().optional(),
      contentType: z.string().optional(),
    }),
  ),
});

export const announcementsSchema = z.array(
  z.object({
    announcementId: id,
    date: z.string(),
    title: z.string(),
    sender: z.string(),
    moduleName: z.string().optional(),
    contentHtml: z.string(),
    hasOpened: z.boolean(),
  }),
);

export const sickOptionsSchema = z.object({
  todayAllowed: z.boolean(),
  tomorrowAllowed: z.boolean(),
  today: z.boolean(),
  tomorrow: z.boolean(),
  doctorsNote: z.string(),
  comment: z.string(),
});

const classesSchema = z.array(
  z.object({
    date: z.string(),
    timeFrom: z.string(),
    timeTo: z.string(),
    class: z.string(),
  }),
);

export const leavesSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    dateFrom: z.string(),
    dateTo: z.string(),
    leaveType: z.string(),
    status: z.string(),
    statusCode: z.number(),
    reasonForLeave: z.string(),
    createdBy: z.string(),
    confirmedBy: z.string().optional(),
    created: z.string(),
    classes: classesSchema,
  }),
);

export const sicknessSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    date: z.string(),
    comment: z.string().optional(),
    statusCode: z.number(),
    allDay: z.string(),
    classes: classesSchema,
  }),
);

export const absenceInputSchema = z
  .object({
    kind: z.enum(['sick', 'leave']),
    dateFrom: date,
    dateTo: date,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine((value) => value.dateFrom <= value.dateTo, 'Dates must be in order.')
  .refine(
    (value) => value.kind !== 'sick' || value.dateFrom === value.dateTo,
    'Register one sick day at a time.',
  );

export type AbsenceInput = z.infer<typeof absenceInputSchema>;

export const absenceRecordSchema = z.object({
  operationId: z.uuid(),
  account: bindingSchema,
  request: absenceInputSchema,
  state: z.enum(['prepared', 'submitting', 'submitted', 'unknown']),
  expiresAt: z.number(),
  upstreamId: z.number().int().positive().optional(),
});

export const absencePreviewSchema = absenceRecordSchema.extend({
  studentName: z.string(),
  schoolName: z.string(),
});
