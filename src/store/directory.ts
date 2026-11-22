import { DomainError } from '../domain/errors.js';
import type { EmployeeId, Office, OfficeId, PresenceStatus, Volunteer } from '../domain/model.js';
import { datesBetween, weekdayOf, type LocalDate, type Weekday } from '../domain/time.js';

/**
 * Offices, the volunteer roster and day-by-day presence. In production the roster would be synced
 * from the company directory (everyone has a company login); presence comes from chat commands:
 * a usual weekly pattern, plus day entries for check-ins, trips to the other office and holidays.
 */
export class Directory {
  private readonly offices = new Map<OfficeId, Office>();
  private readonly volunteers = new Map<EmployeeId, Volunteer>();
  private readonly presence = new Map<string, PresenceStatus>();
  private readonly officeDays = new Map<EmployeeId, ReadonlySet<Weekday>>();

  constructor(offices: readonly Office[], volunteers: readonly Volunteer[] = []) {
    for (const o of offices) this.offices.set(o.id, o);
    for (const v of volunteers) this.upsertVolunteer(v);
  }

  office(id: OfficeId): Office {
    const o = this.offices.get(id);
    if (!o) throw new DomainError('NOT_FOUND', `Unknown office ${id}`);
    return o;
  }

  listOffices(): readonly Office[] {
    return [...this.offices.values()];
  }

  upsertVolunteer(v: Volunteer): void {
    this.office(v.homeOfficeId);
    this.volunteers.set(v.employeeId, v);
  }

  volunteer(id: EmployeeId): Volunteer | undefined {
    return this.volunteers.get(id);
  }

  requireVolunteer(id: EmployeeId): Volunteer {
    const v = this.volunteers.get(id);
    if (!v || !v.active) throw new DomainError('NOT_ALLOWED', `${id} is not an active snack volunteer`);
    return v;
  }

  listVolunteers(): readonly Volunteer[] {
    return [...this.volunteers.values()];
  }

  setPresence(employeeId: EmployeeId, date: LocalDate, status: PresenceStatus): void {
    if (status.kind === 'office') this.office(status.officeId);
    this.presence.set(key(employeeId, date), status);
  }

  /** One command for a whole trip or holiday instead of one per day. */
  setPresenceRange(employeeId: EmployeeId, from: LocalDate, to: LocalDate, status: PresenceStatus): LocalDate[] {
    const days = datesBetween(from, to);
    for (const d of days) this.setPresence(employeeId, d, status);
    return days;
  }

  clearPresence(employeeId: EmployeeId, date: LocalDate): void {
    this.presence.delete(key(employeeId, date));
  }

  /**
   * The volunteer's usual home-office days, e.g. [1, 3, 4] for Mon/Wed/Thu. On other days they count
   * as remote. `null` removes the pattern (back to "unknown" when they haven't said anything).
   */
  setOfficeDays(employeeId: EmployeeId, days: readonly Weekday[] | null): void {
    if (days === null) this.officeDays.delete(employeeId);
    else this.officeDays.set(employeeId, new Set(days));
  }

  usualOfficeDays(employeeId: EmployeeId): readonly Weekday[] | undefined {
    const days = this.officeDays.get(employeeId);
    return days ? [...days].sort() : undefined;
  }

  /**
   * Where someone is on a date. Most specific wins: an entry for that day (check-in, trip, holiday),
   * then their usual weekly pattern. undefined means they haven't told us anything.
   */
  presenceOn(employeeId: EmployeeId, date: LocalDate): PresenceStatus | undefined {
    const explicit = this.presence.get(key(employeeId, date));
    if (explicit) return explicit;
    const pattern = this.officeDays.get(employeeId);
    const v = this.volunteers.get(employeeId);
    if (!pattern || !v) return undefined;
    return pattern.has(weekdayOf(date)) ? { kind: 'office', officeId: v.homeOfficeId } : { kind: 'remote' };
  }
}

function key(employeeId: EmployeeId, date: LocalDate): string {
  return `${employeeId}|${date}`;
}
