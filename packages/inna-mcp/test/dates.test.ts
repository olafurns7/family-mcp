import { expect, test } from 'bun:test';
import { normalizeDate, parseDates } from '../src/dates.js';

test('school dates normalize strictly to UTC without changing date-only values', () => {
  const cases: [Parameters<typeof normalizeDate>[0], string | null][] = [
    ['2040-02-29', '2040-02-29'],
    ['29.2.2040', '2040-02-29'],
    [' 02.01.2040 ', '2040-01-02'],
    ['02.01.2040 9:05', '2040-01-02T09:05:00.000Z'],
    ['2040-01-02T10:15:30', '2040-01-02T10:15:30.000Z'],
    ['2040-01-02 00:00', '2040-01-02T00:00:00.000Z'],
    ['2040-01-02T23:59:59.999Z', '2040-01-02T23:59:59.999Z'],
    ['2040-01-02T00:15:00+01:00', '2040-01-01T23:15:00.000Z'],
    ['2040-01-02T23:15:00-02:00', '2040-01-03T01:15:00.000Z'],
    ['2040-01-02T01:02:03.1Z', '2040-01-02T01:02:03.100Z'],
    [Date.parse('2040-01-02T12:00:00Z'), '2040-01-02T12:00:00.000Z'],
    [1, '1970-01-01T00:00:00.001Z'],
    [0, null],
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
    ['2041-02-29', null],
    ['1900-02-29', null],
    ['31.04.2040', null],
    ['00.01.2040', null],
    ['2040-00-02', null],
    ['2040-13-02', null],
    ['0000-01-01', null],
    ['01/02/2040', null],
    ['2040-01-02 trailing data', null],
    ['02.01.2040 malformed time', null],
    ['2040-01-02T24:00:00', null],
    ['2040-01-02T12:60:00', null],
    ['2040-01-02T12:00:60', null],
    ['2040-01-02T12:00:00+24:00', null],
    ['2040-01-02T12:00:00+01:60', null],
    ['2040-01-02T12:00:00.1234Z', null],
    ['2040-01-02T12:00:00 UTC', null],
    ['2209032000000', null],
    [NaN, null],
    [Infinity, null],
    [1.5, null],
    [Number.MAX_SAFE_INTEGER, null],
  ];

  for (const [source, expected] of cases)
    expect(normalizeDate(source), String(source)).toBe(expected);

  expect(
    parseDates({ absent: undefined, empty: ' ', zero: 0, invalid: 'bad', day: '02.01.2040' }),
  ).toEqual({
    absent: { iso: null, status: 'missing' },
    empty: { iso: null, status: 'missing' },
    zero: { iso: null, status: 'missing' },
    invalid: { iso: null, status: 'unrecognized' },
    day: { iso: '2040-01-02', status: 'parsed' },
  });
});

test('unzoned Inna timestamps stay UTC in hosts with different timezones', async () => {
  for (const TZ of ['Pacific/Honolulu', 'Europe/Berlin', 'Pacific/Auckland']) {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { normalizeDate } from './src/dates.ts'; process.stdout.write(normalizeDate('2040-01-02T10:15:30') ?? 'invalid');`,
      ],
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, TZ },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await new Response(child.stdout).text()).toBe('2040-01-02T10:15:30.000Z');
    expect(await child.exited).toBe(0);
  }
});
