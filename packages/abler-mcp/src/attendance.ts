import { SafeError } from '@family-mcp/mcp-runtime';
import * as z from 'zod/v4';

const id = z.string().min(1).max(256);

export const attendanceInput = z.strictObject({
  childId: id,
  ageGroupId: id,
  eventId: id,
  attendance: z.enum(['attending', 'not_attending']),
  expectedStatus: z
    .string()
    .max(256)
    .nullable()
    .describe('Exact status from a fresh event read, or null. Refuses a concurrent change.'),
});

export const attendanceResult = z.object({
  outcome: z.enum(['updated', 'unchanged', 'unknown']),
  stateVerified: z.boolean(),
  child: z.object({ id, displayName: z.string() }),
  event: z.object({
    eventId: id,
    name: z.string(),
    from: z.string(),
    locationDetails: z.string().nullable(),
  }),
  previousStatus: z.string().nullable(),
  requestedStatus: z.enum(['G', 'N']),
  observedStatus: z.string().nullable(),
});

const person = z.object({ id, displayName: z.string() });

export const eligibilityEvent = z.object({
  eventId: id,
  name: z.string(),
  type: z.string(),
  status: z.string(),
  from: z.iso.datetime({ offset: true }),
  to: z.string().nullable(),
  locationDetails: z.string().nullish(),
  registrationEnd: z.string().nullable(),
  attendanceLimit: z.number(),
  paymentRequestInfo: z.unknown().refine((v) => v !== undefined),
  ageGroup: z.object({ id, guardiansDisabled: z.boolean() }),
  currentPlayerAttendance: z.array(
    z.object({
      player: person,
      status: z.string().nullable(),
      statusExt: z.string().nullable(),
      comment: z.string().nullable(),
      paymentStatus: z.string().nullable(),
      orderId: z.string().nullable(),
      waitingListNr: z.number().nullable(),
    }),
  ),
});

export const eligibilityFields = `
 eventId name type status from to locationDetails registrationEnd attendanceLimit paymentRequestInfo
 ageGroup { id guardiansDisabled }
 currentPlayerAttendance { player { id displayName } status statusExt comment paymentStatus orderId waitingListNr }
`;

export const attendanceMutation = `mutation SetPracticeAttendance(
 $eventId: ID!, $playerId: ID!, $status: PLAYER_ATTENDANCE_STATUS!, $comment: String, $statusExt: eventPlayerStatusExt
) { setPlayerAttendanceV3(eventId:$eventId, playerId:$playerId, status:$status, comment:$comment, statusExt:$statusExt) {
 eventId eventPlayer { status }
} }`;

export function eligiblePractice(
  event: z.infer<typeof eligibilityEvent>,
  input: z.infer<typeof attendanceInput>,
  now: number,
) {
  if (event.eventId !== input.eventId || event.ageGroup.id !== input.ageGroupId)
    throw new SafeError('Abler returned a different event than requested.');

  if (event.type !== 'TRAINING' || event.status !== 'OPEN' || Date.parse(event.from) <= now)
    throw new SafeError('Attendance writes require an open, future practice.');

  if (
    event.registrationEnd !== null &&
    (!z.iso.datetime({ offset: true }).safeParse(event.registrationEnd).success ||
      Date.parse(event.registrationEnd) <= now)
  )
    throw new SafeError('Practice registration is closed or its deadline is unrecognized.');

  if (
    event.paymentRequestInfo !== null ||
    event.attendanceLimit !== -1 ||
    event.ageGroup.guardiansDisabled
  )
    throw new SafeError('Only unpaid, unlimited practices with guardian access are supported.');
  const rows = event.currentPlayerAttendance.filter((row) => row.player.id === input.childId);
  const row = rows[0];

  if (rows.length !== 1 || !row)
    throw new SafeError('The child must have exactly one attendance record on this practice.');

  if (
    row.paymentStatus !== null ||
    row.orderId !== null ||
    row.waitingListNr !== null ||
    row.statusExt !== null
  )
    throw new SafeError(
      'Paid, waiting-list, or extended-reason attendance requires the Abler app.',
    );

  if (row.status !== null && row.status !== 'G' && row.status !== 'N')
    throw new SafeError('Unrecognized attendance status; use the Abler app.');

  if (row.status !== input.expectedStatus)
    throw new SafeError(
      'Attendance changed since the event was read. Read it again before requesting a change.',
    );

  return row;
}
