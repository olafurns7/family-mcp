import { z } from 'zod';

const calendarDate = z.iso.date();

export const datesSchema = z.record(
  z.string(),
  z.object({
    iso: z.union([calendarDate, z.iso.datetime()]).nullable(),
    status: z.enum(['parsed', 'missing', 'unrecognized']),
  }),
);

type SourceDate = string | number | null | undefined;

/** Inna's delivered date model passes numeric dates directly to the Date constructor: milliseconds. */
export function normalizeDate(value: SourceDate): string | null {
  const numeric = z.number().int().safeParse(value);

  if (numeric.success) {
    if (
      numeric.data === 0 ||
      numeric.data < Date.parse('0001-01-01T00:00:00.000Z') ||
      numeric.data > Date.parse('9999-12-31T23:59:59.999Z')
    )
      return null;

    return new Date(numeric.data).toISOString();
  }

  const text = z.string().safeParse(value);

  if (!text.success) return null;
  const input = text.data.trim();

  const icelandic = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(.*)$/.exec(input);

  const source = icelandic
    ? `${icelandic[3]}-${icelandic[2]?.padStart(2, '0')}-${icelandic[1]?.padStart(2, '0')}${icelandic[4]}`
    : input;

  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      source,
    );

  if (!match || match[1]?.startsWith('0000-') || !calendarDate.safeParse(match[1]).success)
    return null;

  if (match[2] === undefined) return match[1] ?? null;
  const hour = match[2].padStart(2, '0');
  const minute = match[3];
  const second = match[4] ?? '00';

  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const offset = match[6] ?? 'Z';

  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
    return null;
  const instant = `${match[1]}T${hour}:${minute}:${second}${match[5] ?? ''}${offset}`;

  if (!z.iso.datetime({ offset: true }).safeParse(instant).success) return null;
  const result = new Date(instant).toISOString();

  return z.iso.datetime().safeParse(result).success ? result : null;
}

export function parseDates(fields: Record<string, SourceDate>): z.infer<typeof datesSchema> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => {
      const iso = normalizeDate(value);

      const empty =
        value === null ||
        value === undefined ||
        value === 0 ||
        z.string().trim().length(0).safeParse(value).success;

      return [field, { iso, status: iso ? 'parsed' : empty ? 'missing' : 'unrecognized' }];
    }),
  );
}
