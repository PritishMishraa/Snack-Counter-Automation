import { DomainError } from '../domain/errors.js';
import {
  ACTIVE_STATUSES,
  type EmployeeId,
  type Office,
  type Refill,
  type RefillEvent,
  type RefillId,
} from '../domain/model.js';
import { compare, format, toDecimalString, zero, type Money } from '../domain/money.js';
import { addMs, formatLocal, localDate, localMonth } from '../domain/time.js';
import type { ChatAction, ChatPort, Clock, HrPort, IdGenerator } from '../ports.js';
import type { Directory } from '../store/directory.js';
import type { RefillStore } from '../store/refill-store.js';
import { budgetPosition, decideSpendLimit, type BudgetPosition } from './budget.js';
import type { Policy } from './policy.js';
import { rankCandidates } from './selection.js';

export interface RefillServiceDeps {
  readonly store: RefillStore;
  readonly directory: Directory;
  readonly chat: ChatPort;
  readonly hr: HrPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policy: Policy;
}

export interface PurchaseInput {
  readonly amount: Money;
  readonly receiptImage: string;
  readonly items?: readonly string[];
}

/**
 * The refill lifecycle:
 *
 *   AWAITING_VOLUNTEER ──commit──▶ COMMITTED ──bought──▶ PURCHASED ──HR accepts──▶ CLAIM_SUBMITTED ──▶ REIMBURSED
 *        │   ▲                         │                    ▲  │                                  └──▶ CLAIM_REJECTED
 *        │   └────── deadline lapses ──┘     over limit ──▶ NEEDS_APPROVAL ──admin approves──┘
 *        └──no budget──▶ ON_HOLD_BUDGET ──next month──▶ AWAITING_VOLUNTEER
 *
 * Every write goes through `write()`, which uses optimistic concurrency: if two people act on the same
 * refill at once, exactly one write succeeds and the other is told what happened.
 * State is saved before anyone is notified, so we never announce something that didn't persist.
 */
export class RefillService {
  private readonly claimsInFlight = new Set<RefillId>();

  constructor(private readonly d: RefillServiceDeps) {}

  // ─── Commands (called from chat) ────────────────────────────────────────────

  async reportEmpty(officeId: string, reportedBy: EmployeeId): Promise<{ refill: Refill; created: boolean }> {
    const office = this.d.directory.office(officeId);
    const now = this.d.clock.now();
    const draft: Refill = {
      id: this.d.ids.next(`R-${office.id}`),
      officeId: office.id,
      status: 'AWAITING_VOLUNTEER',
      version: 1,
      reportedBy,
      reportedAt: now,
      directOffers: 0,
      passedOver: [],
      claimAttempts: 0,
      escalated: false,
      history: [{ at: now, type: 'REPORTED_EMPTY', by: reportedBy }],
    };

    const result = await this.d.store.insertIfNoActive(draft);
    if (!result.inserted) {
      await this.d.chat.sendDirect(reportedBy, `Thanks! ${this.describe(result.existing)}`);
      return { refill: result.existing, created: false };
    }

    await this.d.chat.postToChannel(
      office.channel,
      `The ${office.name} snack box was reported empty by ${this.name(reportedBy)}. Finding someone to refill it.`,
    );
    return { refill: await this.findBuyer(result.refill), created: true };
  }

  async commit(refillId: RefillId, employeeId: EmployeeId): Promise<Refill> {
    this.d.directory.requireVolunteer(employeeId);
    const refill = await this.load(refillId);

    if (refill.status === 'COMMITTED') {
      if (refill.commitment!.buyer === employeeId) return refill;
      throw new DomainError('ALREADY_TAKEN', `${this.name(refill.commitment!.buyer)} is already refilling this one. No need to buy.`);
    }
    if (refill.status === 'ON_HOLD_BUDGET') {
      throw new DomainError('BUDGET_EXCEEDED', "This month's snack budget is used up, so the refill resumes next month. Please don't buy.");
    }
    if (refill.status !== 'AWAITING_VOLUNTEER') {
      throw new DomainError('INVALID_STATE', `This refill is no longer looking for a buyer (${refill.status}).`);
    }

    const office = this.d.directory.office(refill.officeId);
    const position = await this.budget(office);
    const decision = decideSpendLimit(office, position);
    if (!decision.ok) {
      await this.findBuyer(refill);
      throw new DomainError('BUDGET_EXCEEDED', `Only ${format(decision.remaining)} left this month, so this refill is on hold.`);
    }

    const now = this.d.clock.now();
    let next: Refill;
    try {
      next = await this.write(
        refill,
        {
          status: 'COMMITTED',
          offer: undefined,
          lapsedBuyer: undefined,
          commitment: {
            buyer: employeeId,
            committedAt: now,
            dueAt: addMs(now, this.d.policy.commitWindowMs),
            spendLimit: decision.spendLimit,
            budgetMonth: position.month,
            reminderSent: false,
          },
        },
        'COMMITTED',
        employeeId,
      );
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'CONCURRENT_UPDATE')) throw e;
      const latest = await this.load(refillId);
      if (latest.status === 'COMMITTED' && latest.commitment!.buyer === employeeId) return latest;
      if (latest.status === 'COMMITTED') {
        throw new DomainError('ALREADY_TAKEN', `${this.name(latest.commitment!.buyer)} got there first. No need to buy.`);
      }
      throw new DomainError('CONCURRENT_UPDATE', 'The refill changed while you were answering. Please try again.');
    }

    const c = next.commitment!;
    await this.d.chat.sendDirect(
      employeeId,
      `You're on it, thank you! Spend up to ${format(c.spendLimit)} and report it by ${this.when(c.dueAt, office)} ` +
        `with "/snack bought ${next.id} <amount> <receipt>". The claim is filed for you automatically.`,
    );
    await this.d.chat.postToChannel(office.channel, `${this.name(employeeId)} is refilling the snack box. Please don't buy.`);
    const offeredTo = refill.offer?.to;
    if (offeredTo && offeredTo !== employeeId) {
      await this.d.chat.sendDirect(offeredTo, `Never mind, ${this.name(employeeId)} picked up refill ${next.id}.`);
    }
    if (refill.lapsedBuyer && refill.lapsedBuyer !== employeeId) {
      await this.d.chat.sendDirect(
        refill.lapsedBuyer,
        `${this.name(employeeId)} has taken over refill ${next.id}. Please don't buy for it now.`,
      );
    }
    return next;
  }

  async decline(refillId: RefillId, employeeId: EmployeeId): Promise<Refill> {
    const refill = await this.load(refillId);
    if (refill.status !== 'AWAITING_VOLUNTEER' || refill.passedOver.includes(employeeId)) return refill;
    const next = await this.write(refill, { passedOver: [...refill.passedOver, employeeId] }, 'DECLINED', employeeId);
    return refill.offer?.to === employeeId ? this.findBuyer(next) : next;
  }

  async recordPurchase(refillId: RefillId, employeeId: EmployeeId, input: PurchaseInput): Promise<Refill> {
    const refill = await this.load(refillId);
    const office = this.d.directory.office(refill.officeId);
    if (input.amount.currency !== office.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `${office.name} refills are bought and claimed in ${office.currency}.`);
    }
    if (input.amount.minor <= 0) throw new DomainError('INVALID_AMOUNT', 'The amount must be positive.');
    if (!input.receiptImage.trim()) throw new DomainError('NOT_ALLOWED', 'A receipt image is required for reimbursement.');

    let limit: Money;
    let budgetMonth: string;
    if (refill.status === 'COMMITTED' && refill.commitment!.buyer === employeeId) {
      limit = refill.commitment!.spendLimit;
      budgetMonth = refill.commitment!.budgetMonth;
    } else if (refill.status === 'AWAITING_VOLUNTEER' && refill.lapsedBuyer === employeeId) {
      // Their deadline passed but nobody else has committed yet, so a late purchase is still the one we use.
      const position = await this.budget(office);
      const decision = decideSpendLimit(office, position);
      limit = decision.ok ? decision.spendLimit : zero(office.currency);
      budgetMonth = position.month;
    } else if (refill.status === 'COMMITTED') {
      throw new DomainError('NOT_ALLOWED', `${this.name(refill.commitment!.buyer)} is the buyer for this refill.`);
    } else {
      throw new DomainError('INVALID_STATE', `You can only report a purchase for a refill you committed to (${refill.status}).`);
    }

    const overLimit = compare(input.amount, limit) > 0;
    const next = await this.write(
      refill,
      {
        status: overLimit ? 'NEEDS_APPROVAL' : 'PURCHASED',
        offer: undefined,
        lapsedBuyer: undefined,
        purchase: {
          buyer: employeeId,
          amount: input.amount,
          receiptImage: input.receiptImage,
          items: normaliseItems(input.items ?? []),
          purchasedAt: this.d.clock.now(),
          budgetMonth,
        },
      },
      overLimit ? 'PURCHASED_OVER_LIMIT' : 'PURCHASED',
      employeeId,
      format(input.amount),
    );

    await this.d.chat.postToChannel(office.channel, `The snack box has been refilled by ${this.name(employeeId)}. Thanks!`);
    const offeredTo = refill.offer?.to;
    if (offeredTo && offeredTo !== employeeId) {
      await this.d.chat.sendDirect(offeredTo, `Never mind, ${this.name(employeeId)} already refilled ${next.id}.`);
    }

    if (overLimit) {
      await this.d.chat.sendDirect(
        employeeId,
        `Your receipt (${format(input.amount)}) is above the ${format(limit)} limit, so an admin will review it before the claim is filed.`,
      );
      await this.notifyAdmins(
        office,
        `Refill ${next.id}: ${this.name(employeeId)} spent ${format(input.amount)}, above the ${format(limit)} limit.`,
        [
          { label: 'Approve', command: `/snack approve ${next.id}` },
          { label: 'Reject', command: `/snack reject ${next.id} <reason>` },
        ],
      );
      return next;
    }
    return this.submitClaim(next);
  }

  async approvePurchase(refillId: RefillId, adminId: EmployeeId): Promise<Refill> {
    const refill = await this.load(refillId);
    this.requireAdmin(refill, adminId);
    if (refill.status !== 'NEEDS_APPROVAL') throw new DomainError('INVALID_STATE', `Refill ${refillId} is not awaiting approval.`);
    const next = await this.write(refill, { status: 'PURCHASED' }, 'APPROVED_OVER_LIMIT', adminId);
    return this.submitClaim(next);
  }

  async rejectPurchase(refillId: RefillId, adminId: EmployeeId, reason: string): Promise<Refill> {
    const refill = await this.load(refillId);
    this.requireAdmin(refill, adminId);
    if (refill.status !== 'NEEDS_APPROVAL') throw new DomainError('INVALID_STATE', `Refill ${refillId} is not awaiting approval.`);
    const next = await this.write(refill, { status: 'CLAIM_REJECTED' }, 'REJECTED_OVER_LIMIT', adminId, reason);
    await this.d.chat.sendDirect(next.purchase!.buyer, `Your over-limit receipt for ${next.id} was not approved: ${reason}`);
    return next;
  }

  /** False alarm, or an admin closing a stuck refill. */
  async cancel(refillId: RefillId, by: EmployeeId, reason: string): Promise<Refill> {
    const refill = await this.load(refillId);
    const office = this.d.directory.office(refill.officeId);
    if (!ACTIVE_STATUSES.has(refill.status)) throw new DomainError('INVALID_STATE', `Refill ${refillId} can no longer be cancelled.`);
    if (by !== refill.reportedBy && !office.admins.includes(by)) {
      throw new DomainError('NOT_ALLOWED', 'Only the reporter or an office admin can cancel a refill.');
    }
    const next = await this.write(refill, { status: 'CANCELLED', offer: undefined }, 'CANCELLED', by, reason);
    if (refill.commitment) await this.d.chat.sendDirect(refill.commitment.buyer, `Refill ${refill.id} was cancelled (${reason}). Please don't buy.`);
    await this.d.chat.postToChannel(office.channel, `Refill ${refill.id} was cancelled: ${reason}`);
    return next;
  }

  async get(refillId: RefillId): Promise<Refill> {
    return this.load(refillId);
  }

  async status(officeId: string): Promise<string> {
    const office = this.d.directory.office(officeId);
    const active = await this.d.store.findActive(office.id);
    const pos = await this.budget(office);
    const box = active ? this.describe(active) : 'The snack box is not reported empty.';
    return `${box} Budget ${pos.month}: ${format(pos.spent)} spent, ${format(pos.reserved)} reserved, ${format(pos.remaining)} left of ${format(pos.budget)}.`;
  }

  async budget(office: Office): Promise<BudgetPosition> {
    return budgetPosition(office, localMonth(this.d.clock.now(), office.timeZone), await this.d.store.list());
  }

  // ─── Scheduler ──────────────────────────────────────────────────────────────

  /**
   * Run every few minutes. Handles everything time-based: expired offers, reminders, lapsed
   * commitments, budget holds at the start of a month, HR retries and HR status polling.
   * A refill that changed underneath us is simply skipped; the next tick sees the new state.
   * One failing refill (e.g. HR timing out) never stops the others; failures are returned for logging.
   */
  async tick(): Promise<Array<{ refillId: RefillId; error: unknown }>> {
    const failures: Array<{ refillId: RefillId; error: unknown }> = [];
    for (const refill of await this.d.store.list()) {
      try {
        await this.tickOne(refill);
      } catch (e) {
        if (e instanceof DomainError && e.code === 'CONCURRENT_UPDATE') continue;
        failures.push({ refillId: refill.id, error: e });
      }
    }
    return failures;
  }

  private async tickOne(refill: Refill): Promise<void> {
    const now = this.d.clock.now();
    switch (refill.status) {
      case 'AWAITING_VOLUNTEER': {
        if (refill.offer && now < refill.offer.expiresAt) return;
        const to = refill.offer?.to;
        if (to) {
          const next = await this.write(refill, { passedOver: [...refill.passedOver, to], offer: undefined }, 'OFFER_EXPIRED', to);
          await this.d.chat.sendDirect(to, `No worries, I've asked someone else to refill ${refill.id}.`);
          await this.findBuyer(next);
        } else {
          await this.findBuyer(refill);
        }
        return;
      }
      case 'COMMITTED': {
        const c = refill.commitment!;
        if (now >= c.dueAt) {
          const next = await this.write(
            refill,
            { status: 'AWAITING_VOLUNTEER', commitment: undefined, lapsedBuyer: c.buyer, passedOver: [...refill.passedOver, c.buyer] },
            'COMMITMENT_LAPSED',
            c.buyer,
          );
          await this.d.chat.sendDirect(
            c.buyer,
            `Refill ${refill.id} wasn't reported in time, so I'm handing it to someone else. ` +
              `If you already bought, report it now with "/snack bought ${refill.id} <amount> <receipt>".`,
          );
          await this.findBuyer(next);
        } else if (!c.reminderSent && now.getTime() >= c.dueAt.getTime() - this.d.policy.reminderLeadMs) {
          await this.write(refill, { commitment: { ...c, reminderSent: true } }, 'REMINDED', c.buyer);
          await this.d.chat.sendDirect(
            c.buyer,
            `Reminder: refill ${refill.id} is due by ${this.when(c.dueAt, this.d.directory.office(refill.officeId))}. Can't make it? "/snack release ${refill.id}" hands it on.`,
            [{ label: "Can't make it", command: `/snack release ${refill.id}` }],
          );
        }
        return;
      }
      case 'ON_HOLD_BUDGET':
        await this.findBuyer(refill);
        return;
      case 'PURCHASED':
        await this.submitClaim(refill);
        return;
      case 'CLAIM_SUBMITTED':
        await this.pollClaim(refill);
        return;
      default:
        return;
    }
  }

  /** The committed buyer can't make it after all. */
  async release(refillId: RefillId, employeeId: EmployeeId): Promise<Refill> {
    const refill = await this.load(refillId);
    if (refill.status !== 'COMMITTED' || refill.commitment!.buyer !== employeeId) {
      throw new DomainError('NOT_ALLOWED', 'You are not the committed buyer for this refill.');
    }
    const next = await this.write(
      refill,
      { status: 'AWAITING_VOLUNTEER', commitment: undefined, passedOver: [...refill.passedOver, employeeId] },
      'RELEASED',
      employeeId,
    );
    return this.findBuyer(next);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Checks the budget, then offers the refill to the best candidate, or to the whole channel. */
  private async findBuyer(refill: Refill): Promise<Refill> {
    const office = this.d.directory.office(refill.officeId);
    const now = this.d.clock.now();
    const all = await this.d.store.list();
    const position = budgetPosition(office, localMonth(now, office.timeZone), all);
    const decision = decideSpendLimit(office, position);

    if (!decision.ok) {
      if (refill.status === 'ON_HOLD_BUDGET') return refill;
      const next = await this.write(refill, { status: 'ON_HOLD_BUDGET', offer: undefined }, 'BUDGET_HOLD', undefined, format(decision.remaining));
      const text = `The ${office.name} snack budget for ${position.month} is used up (${format(decision.remaining)} left). The refill resumes automatically next month.`;
      await this.d.chat.postToChannel(office.channel, text);
      await this.notifyAdmins(office, `${text} Refill ${refill.id} is on hold.`);
      return next;
    }

    const ranked = rankCandidates({
      office,
      today: localDate(now, office.timeZone),
      now,
      volunteers: this.d.directory.listVolunteers(),
      presenceOn: (id, date) => this.d.directory.presenceOn(id, date),
      refills: all,
      exclude: new Set(refill.passedOver),
      policy: this.d.policy,
    });
    const pick = ranked[0];

    if (pick && refill.directOffers < this.d.policy.maxDirectOffers) {
      const next = await this.write(
        refill,
        {
          status: 'AWAITING_VOLUNTEER',
          directOffers: refill.directOffers + 1,
          offer: { to: pick.employeeId, sentAt: now, expiresAt: addMs(now, this.d.policy.offerTimeoutMs) },
        },
        'OFFERED',
        pick.employeeId,
      );
      await this.d.chat.sendDirect(
        pick.employeeId,
        `The ${office.name} snack box is empty. Could you refill it today? Budget up to ${format(decision.spendLimit)}. ` +
          `You're being asked because you've done ${pick.recentRefills} refill(s) in the last 30 days.`,
        [
          { label: "Yes, I'll buy", command: `/snack yes ${refill.id}` },
          { label: "Can't today", command: `/snack no ${refill.id}` },
        ],
      );
      return next;
    }

    const repeat = refill.offer?.to === null;
    const next = await this.write(
      refill,
      {
        status: 'AWAITING_VOLUNTEER',
        escalated: refill.escalated || repeat,
        offer: { to: null, sentAt: now, expiresAt: addMs(now, this.d.policy.broadcastTimeoutMs) },
      },
      'BROADCAST',
    );
    await this.d.chat.postToChannel(
      office.channel,
      `${repeat ? 'Still empty: ' : ''}The ${office.name} snack box needs a refill and nobody has picked it up yet. ` +
        `Anyone in the office today? Budget up to ${format(decision.spendLimit)}.`,
      [{ label: "I'll do it", command: `/snack yes ${refill.id}` }],
    );
    if (repeat && !refill.escalated) {
      await this.notifyAdmins(office, `Nobody has picked up refill ${refill.id} since ${this.when(refill.reportedAt, office)}.`);
    }
    return next;
  }

  private async submitClaim(refill: Refill): Promise<Refill> {
    if (this.claimsInFlight.has(refill.id)) return refill;
    this.claimsInFlight.add(refill.id);
    try {
      const office = this.d.directory.office(refill.officeId);
      const p = refill.purchase!;
      const items = p.items.length ? `: ${p.items.join(', ')}` : '';
      let claimId: string;
      try {
        claimId = await this.d.hr.createClaim({
          employeeId: p.buyer,
          amount: toDecimalString(p.amount),
          currency: p.amount.currency,
          description: `Snack refill, ${office.name} office, ${p.budgetMonth} [${refill.id}]${items}`,
          receiptImage: p.receiptImage,
        });
      } catch (e) {
        const next = await this.write(refill, { claimAttempts: refill.claimAttempts + 1 }, 'CLAIM_SUBMIT_FAILED', undefined, String(e));
        if (next.claimAttempts === this.d.policy.claimAttemptsBeforeEscalation) {
          await this.notifyAdmins(office, `Filing the HR claim for ${refill.id} has failed ${next.claimAttempts} times. Still retrying.`);
        }
        return next;
      }

      const next = await this.write(
        refill,
        { status: 'CLAIM_SUBMITTED', claimAttempts: refill.claimAttempts + 1, claim: { claimId, submittedAt: this.d.clock.now() } },
        'CLAIM_SUBMITTED',
        undefined,
        claimId,
      );
      await this.d.chat.sendDirect(
        p.buyer,
        `I've filed reimbursement claim ${claimId} for ${format(p.amount)}. HR usually approves within 1-10 days, ` +
          `and you'll be paid in your payroll currency. I'll tell you when it's approved.`,
      );
      return next;
    } finally {
      this.claimsInFlight.delete(refill.id);
    }
  }

  private async pollClaim(refill: Refill): Promise<void> {
    const claim = refill.claim!;
    const status = await this.d.hr.getClaimStatus(claim.claimId);
    const buyer = refill.purchase!.buyer;
    const office = this.d.directory.office(refill.officeId);

    if (status.state === 'APPROVED') {
      await this.write(refill, { status: 'REIMBURSED', claim: { ...claim, decidedAt: status.decidedAt } }, 'REIMBURSED');
      await this.d.chat.sendDirect(buyer, `HR approved claim ${claim.claimId} for ${format(refill.purchase!.amount)}. Thanks for refilling!`);
    } else if (status.state === 'REJECTED') {
      await this.write(
        refill,
        { status: 'CLAIM_REJECTED', claim: { ...claim, decidedAt: status.decidedAt, rejectionReason: status.reason } },
        'CLAIM_REJECTED',
        undefined,
        status.reason,
      );
      await this.d.chat.sendDirect(buyer, `HR rejected claim ${claim.claimId}: ${status.reason}. An admin has been told and will follow up.`);
      await this.notifyAdmins(office, `HR rejected claim ${claim.claimId} (${refill.id}, ${this.name(buyer)}): ${status.reason}`);
    } else if (!claim.overdueEscalated && this.d.clock.now().getTime() - claim.submittedAt.getTime() > this.d.policy.claimOverdueMs) {
      await this.write(refill, { claim: { ...claim, overdueEscalated: true } }, 'CLAIM_OVERDUE');
      await this.notifyAdmins(office, `Claim ${claim.claimId} (${refill.id}, ${this.name(buyer)}) has been pending for over 10 days. Please chase HR.`);
    }
  }

  private async write(prev: Refill, patch: Partial<Refill>, type: string, by?: EmployeeId, detail?: string): Promise<Refill> {
    const event: RefillEvent = { at: this.d.clock.now(), type, ...(by && { by }), ...(detail && { detail }) };
    const next: Refill = { ...prev, ...patch, version: prev.version + 1, history: [...prev.history, event] };
    return this.d.store.save(next, prev.version);
  }

  private async load(id: RefillId): Promise<Refill> {
    const r = await this.d.store.get(id);
    if (!r) throw new DomainError('NOT_FOUND', `No refill ${id}`);
    return r;
  }

  private requireAdmin(refill: Refill, adminId: EmployeeId): void {
    if (!this.d.directory.office(refill.officeId).admins.includes(adminId)) {
      throw new DomainError('NOT_ALLOWED', 'Only an office admin can do that.');
    }
  }

  private async notifyAdmins(office: Office, text: string, actions?: readonly ChatAction[]): Promise<void> {
    for (const admin of office.admins) await this.d.chat.sendDirect(admin, text, actions);
  }

  private describe(r: Refill): string {
    switch (r.status) {
      case 'COMMITTED':
        return `${this.name(r.commitment!.buyer)} is already refilling the snack box (${r.id}).`;
      case 'ON_HOLD_BUDGET':
        return `The snack box is empty but this month's budget is used up (${r.id}).`;
      default:
        return r.offer?.to
          ? `The snack box is already reported empty and ${this.name(r.offer.to)} has been asked to refill it (${r.id}).`
          : `The snack box is already reported empty and we're looking for a buyer (${r.id}).`;
    }
  }

  private when(instant: Date, office: Office): string {
    return `${formatLocal(instant, office.timeZone)} ${office.name} time`;
  }

  private name(id: EmployeeId): string {
    return this.d.directory.volunteer(id)?.name ?? id;
  }
}

function normaliseItems(items: readonly string[]): string[] {
  return [...new Set(items.map((i) => i.trim().toLowerCase()).filter(Boolean))];
}
