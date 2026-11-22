import { DomainError } from '../domain/errors.js';
import type { EmployeeId, Office } from '../domain/model.js';
import { fromMinor } from '../domain/money.js';
import { localDate, type LocalDate, type Weekday } from '../domain/time.js';
import type { Clock } from '../ports.js';
import type { RefillService } from '../core/refill-service.js';
import type { Directory } from '../store/directory.js';

export const HELP = [
  '/snack empty [office]            report the box as empty',
  '/snack yes <refill>              commit to buying',
  '/snack no <refill>               decline an offer',
  '/snack release <refill>          give back a refill you committed to',
  '/snack bought <refill> <amount> <receipt-url> [item, item, ...]',
  '/snack here [office]             I am in this office today',
  '/snack remote                    I am working from home today',
  '/snack holiday <from> [to]       dates as YYYY-MM-DD',
  '/snack visiting <office> <from> [to]   a trip to the other office',
  '/snack days mon,wed,thu          my usual office days ("none" to clear)',
  '/snack status [office]',
  '/snack approve <refill> | reject <refill> <reason> | cancel <refill> <reason>   (admins)',
].join('\n');

/**
 * Translates chat slash-commands and button presses into service calls, and errors into friendly
 * replies. Buttons in chat messages send the same commands, so there is one code path for both.
 */
export class ChatCommands {
  constructor(
    private readonly service: RefillService,
    private readonly directory: Directory,
    private readonly clock: Clock,
  ) {}

  async handle(from: EmployeeId, text: string): Promise<string> {
    const [prefix, command = 'help', ...args] = text.trim().split(/\s+/);
    if (prefix !== '/snack') return HELP;
    try {
      return await this.dispatch(from, command.toLowerCase(), args);
    } catch (e) {
      if (e instanceof DomainError) return e.message;
      throw e;
    }
  }

  private async dispatch(from: EmployeeId, command: string, args: string[]): Promise<string> {
    switch (command) {
      case 'empty': {
        const office = args[0] ? this.resolveOffice(args[0]) : this.currentOffice(from);
        const { refill, created } = await this.service.reportEmpty(office.id, from);
        return created ? `Thanks, refill ${refill.id} started for ${office.name}.` : `Already being handled (${refill.id}).`;
      }
      case 'yes':
        await this.service.commit(requireArg(args, 0, 'refill id'), from);
        return 'Great, it is yours. Check your direct messages for the budget and deadline.';
      case 'no':
        await this.service.decline(requireArg(args, 0, 'refill id'), from);
        return "No problem, I'll ask someone else.";
      case 'release':
        await this.service.release(requireArg(args, 0, 'refill id'), from);
        return "Released. I'll find someone else.";
      case 'bought': {
        const refillId = requireArg(args, 0, 'refill id');
        const refill = await this.service.get(refillId);
        const office = this.directory.office(refill.officeId);
        const amount = parseAmount(requireArg(args, 1, 'amount'));
        const receipt = requireArg(args, 2, 'receipt');
        const items = args.slice(3).join(' ').split(',').map((s) => s.trim()).filter(Boolean);
        const updated = await this.service.recordPurchase(refillId, from, {
          amount: fromMinor(amount, office.currency),
          receiptImage: receipt,
          items,
        });
        return updated.status === 'NEEDS_APPROVAL'
          ? 'Recorded. It is above the limit, so an admin will review it first.'
          : 'Recorded, thank you! Your reimbursement claim has been filed.';
      }
      case 'here': {
        const office = args[0] ? this.resolveOffice(args[0]) : this.homeOffice(from);
        this.directory.setPresence(from, this.today(office), { kind: 'office', officeId: office.id });
        return `Noted: you're in ${office.name} today.`;
      }
      case 'remote': {
        const office = this.homeOffice(from);
        this.directory.setPresence(from, this.today(office), { kind: 'remote' });
        return "Noted: you're remote today. I won't ask you to refill.";
      }
      case 'holiday': {
        const [fromDate, toDate] = parseRange(args[0], args[1]);
        this.directory.setPresenceRange(from, fromDate, toDate, { kind: 'holiday' });
        return `Enjoy! I won't ask you to refill from ${fromDate} to ${toDate}.`;
      }
      case 'visiting': {
        const office = this.resolveOffice(requireArg(args, 0, 'office'));
        const [fromDate, toDate] = parseRange(args[1], args[2]);
        this.directory.setPresenceRange(from, fromDate, toDate, { kind: 'office', officeId: office.id });
        const home = this.homeOffice(from);
        return office.id === home.id
          ? `Noted: you're in ${office.name} from ${fromDate} to ${toDate}.`
          : `Have a good trip! From ${fromDate} to ${toDate} I may ask you to help in ${office.name}, and won't ask you in ${home.name}.`;
      }
      case 'days': {
        const days = parseWeekdays(requireArg(args, 0, 'days, e.g. mon,wed,thu'));
        this.directory.setOfficeDays(from, days);
        return days === null
          ? 'Cleared your usual office days.'
          : `Noted: you're usually in the office on ${days.map((d) => capitalise(WEEKDAYS[d])).join(', ')}. Use /snack here or /snack remote to override a single day.`;
      }
      case 'status': {
        const office = args[0] ? this.resolveOffice(args[0]) : this.currentOffice(from);
        return this.service.status(office.id);
      }
      case 'approve':
        await this.service.approvePurchase(requireArg(args, 0, 'refill id'), from);
        return 'Approved. The claim has been filed.';
      case 'reject':
        await this.service.rejectPurchase(requireArg(args, 0, 'refill id'), from, args.slice(1).join(' ') || 'no reason given');
        return 'Rejected. The buyer has been told.';
      case 'cancel':
        await this.service.cancel(requireArg(args, 0, 'refill id'), from, args.slice(1).join(' ') || 'no reason given');
        return 'Cancelled.';
      case 'help':
        return HELP;
      default:
        throw new DomainError('UNKNOWN_COMMAND', `Unknown command "${command}".\n${HELP}`);
    }
  }

  /** Where the person is today: the office they checked into, otherwise their home office. */
  private currentOffice(employeeId: EmployeeId): Office {
    for (const office of this.directory.listOffices()) {
      const p = this.directory.presenceOn(employeeId, this.today(office));
      if (p?.kind === 'office') return this.directory.office(p.officeId);
    }
    return this.homeOffice(employeeId);
  }

  private homeOffice(employeeId: EmployeeId): Office {
    return this.directory.office(this.directory.requireVolunteer(employeeId).homeOfficeId);
  }

  private resolveOffice(input: string): Office {
    const needle = input.toLowerCase();
    const match = this.directory.listOffices().find((o) => o.id.toLowerCase() === needle || o.name.toLowerCase() === needle);
    if (!match) throw new DomainError('NOT_FOUND', `Unknown office "${input}".`);
    return match;
  }

  private today(office: Office): LocalDate {
    return localDate(this.clock.now(), office.timeZone);
  }
}

function requireArg(args: string[], i: number, what: string): string {
  const v = args[i];
  if (!v) throw new DomainError('INVALID_STATE', `Missing ${what}.\n${HELP}`);
  return v;
}

/** Accepts "450", "450.5", "450,50". Returns minor units. */
export function parseAmount(input: string): number {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(input);
  if (!m) throw new DomainError('INVALID_AMOUNT', `"${input}" is not a valid amount. Use e.g. 450 or 450.50.`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

function parseDate(input: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(Date.parse(`${input}T00:00:00Z`))) {
    throw new DomainError('INVALID_STATE', `"${input}" is not a date. Use YYYY-MM-DD.`);
  }
  return input;
}

function parseRange(fromArg: string | undefined, toArg: string | undefined): [LocalDate, LocalDate] {
  const from = parseDate(fromArg ?? '');
  const to = toArg ? parseDate(toArg) : from;
  if (to < from) throw new DomainError('INVALID_STATE', 'The end date is before the start date.');
  return [from, to];
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "mon,wed,thu" → [1, 3, 4]; "none" → null. */
export function parseWeekdays(input: string): Weekday[] | null {
  if (input.toLowerCase() === 'none') return null;
  const days = input.toLowerCase().split(',').map((s) => s.trim().slice(0, 3)).filter(Boolean);
  const out = days.map((d) => {
    const i = WEEKDAYS.indexOf(d as (typeof WEEKDAYS)[number]);
    if (i < 0) throw new DomainError('INVALID_STATE', `"${d}" is not a weekday. Use e.g. mon,wed,thu.`);
    return i as Weekday;
  });
  return [...new Set(out)].sort();
}
