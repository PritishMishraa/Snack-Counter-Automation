/** A calendar date in an office's local time zone, formatted YYYY-MM-DD. */
export type LocalDate = string;
/** A budget month in an office's local time zone, formatted YYYY-MM. */
export type Month = string;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localDate(instant: Date, timeZone: string): LocalDate {
  return formatterFor(timeZone).format(instant);
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** 0–23 in the given time zone. */
export function localHour(instant: Date, timeZone: string): number {
  let f = hourFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    hourFormatters.set(timeZone, f);
  }
  return Number(f.format(instant));
}

export function localMonth(instant: Date, timeZone: string): Month {
  return localDate(instant, timeZone).slice(0, 7);
}

/** 0 = Sunday … 6 = Saturday, for a calendar date (no time zone involved). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function weekdayOf(date: LocalDate): Weekday {
  return new Date(`${date}T12:00:00Z`).getUTCDay() as Weekday;
}

/** Inclusive list of dates from `from` to `to`. Capped at a year to keep typos harmless. */
export function datesBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length <= 366; t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** "Tue 3 Nov, 10:35" in the office's local time, for chat messages. */
export function formatLocal(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

export function addMs(instant: Date, ms: number): Date {
  return new Date(instant.getTime() + ms);
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR;
}
