import type { EmployeeId, Office, Refill } from '../domain/model.js';
import { add, convert, format, subtract, sum, type Currency, type Money } from '../domain/money.js';
import { hoursBetween, type Month } from '../domain/time.js';
import type { ExchangeRates } from '../ports.js';

export interface OfficeReport {
  readonly officeId: string;
  readonly office: string;
  readonly currency: Currency;
  readonly budget: Money;
  /** reimbursed + awaitingReimbursement. This is what the company has spent. */
  readonly spent: Money;
  readonly reimbursed: Money;
  /** Receipts in admin review, being filed, or waiting on HR. Owed to volunteers. */
  readonly awaitingReimbursement: Money;
  /** Not counted as spent; listed so nothing disappears silently. */
  readonly rejected: Money;
  readonly remaining: Money;
  readonly utilisationPct: number;
  readonly refills: number;
  /** Average hours from "reported empty" to "snacks bought". The box's real downtime. */
  readonly avgHoursEmpty: number | null;
  readonly topItems: ReadonlyArray<{ readonly item: string; readonly refills: number }>;
  readonly refillsByVolunteer: Readonly<Record<EmployeeId, number>>;
  /** Rate used to convert this office's figures into the reporting currency. */
  readonly rate: number;
  readonly spentConverted: Money;
  readonly budgetConverted: Money;
}

export interface MonthlyReport {
  readonly month: Month;
  readonly reportingCurrency: Currency;
  readonly offices: readonly OfficeReport[];
  readonly total: {
    readonly budget: Money;
    readonly spent: Money;
    readonly reimbursed: Money;
    readonly awaitingReimbursement: Money;
    readonly utilisationPct: number;
  };
}

/**
 * One report for management covering both offices. Each office is first totalled exactly in its own
 * currency; only those totals are converted, once, at that month's rate. Converting each receipt
 * separately would add a rounding error per receipt and make the report disagree with the budget view.
 */
export function buildMonthlyReport(
  month: Month,
  offices: readonly Office[],
  refills: readonly Refill[],
  rates: ExchangeRates,
  reportingCurrency: Currency,
): MonthlyReport {
  const officeReports = offices.map((office) => officeReport(month, office, refills, rates, reportingCurrency));

  const totalOf = (pick: (o: OfficeReport) => Money) =>
    sum(
      officeReports.map((o) => convert(pick(o), reportingCurrency, o.rate)),
      reportingCurrency,
    );
  const budget = sum(officeReports.map((o) => o.budgetConverted), reportingCurrency);
  const spent = sum(officeReports.map((o) => o.spentConverted), reportingCurrency);

  return {
    month,
    reportingCurrency,
    offices: officeReports,
    total: {
      budget,
      spent,
      reimbursed: totalOf((o) => o.reimbursed),
      awaitingReimbursement: totalOf((o) => o.awaitingReimbursement),
      utilisationPct: pct(spent, budget),
    },
  };
}

function officeReport(month: Month, office: Office, all: readonly Refill[], rates: ExchangeRates, to: Currency): OfficeReport {
  const refills = all.filter((r) => r.officeId === office.id && r.purchase?.budgetMonth === month);
  const amounts = (statuses: string[]) =>
    sum(
      refills.filter((r) => statuses.includes(r.status)).map((r) => r.purchase!.amount),
      office.currency,
    );

  const reimbursed = amounts(['REIMBURSED']);
  const awaitingReimbursement = amounts(['NEEDS_APPROVAL', 'PURCHASED', 'CLAIM_SUBMITTED']);
  const rejected = amounts(['CLAIM_REJECTED']);
  const spent = add(reimbursed, awaitingReimbursement);
  const counted = refills.filter((r) => r.status !== 'CLAIM_REJECTED');

  const itemCounts = new Map<string, number>();
  const byVolunteer: Record<EmployeeId, number> = {};
  for (const r of counted) {
    for (const item of r.purchase!.items) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
    byVolunteer[r.purchase!.buyer] = (byVolunteer[r.purchase!.buyer] ?? 0) + 1;
  }
  const topItems = [...itemCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([item, n]) => ({ item, refills: n }));

  const downtimes = counted.map((r) => hoursBetween(r.reportedAt, r.purchase!.purchasedAt));
  const rate = rates.rate(office.currency, to, month);

  return {
    officeId: office.id,
    office: office.name,
    currency: office.currency,
    budget: office.monthlyBudget,
    spent,
    reimbursed,
    awaitingReimbursement,
    rejected,
    remaining: subtract(office.monthlyBudget, spent),
    utilisationPct: pct(spent, office.monthlyBudget),
    refills: counted.length,
    avgHoursEmpty: downtimes.length ? round1(downtimes.reduce((a, b) => a + b, 0) / downtimes.length) : null,
    topItems,
    refillsByVolunteer: byVolunteer,
    rate,
    spentConverted: convert(spent, to, rate),
    budgetConverted: convert(office.monthlyBudget, to, rate),
  };
}

export function renderReport(r: MonthlyReport): string {
  const lines = [`Snack spending report for ${r.month} (totals in ${r.reportingCurrency})`, ''];
  for (const o of r.offices) {
    lines.push(
      `${o.office}: ${format(o.spent)} of ${format(o.budget)} (${o.utilisationPct}%), ${o.refills} refill(s)` +
        (o.currency !== r.reportingCurrency ? ` = ${format(o.spentConverted)} at ${o.rate}` : ''),
      `  reimbursed ${format(o.reimbursed)}, awaiting ${format(o.awaitingReimbursement)}, rejected ${format(o.rejected)}`,
      `  box empty on average ${o.avgHoursEmpty ?? '-'} h before refill; top items: ${o.topItems.map((t) => t.item).join(', ') || '-'}`,
    );
  }
  lines.push('', `Total: ${format(r.total.spent)} of ${format(r.total.budget)} (${r.total.utilisationPct}%)`);
  return lines.join('\n');
}

function pct(part: Money, whole: Money): number {
  if (whole.minor === 0) return 0;
  return round1((part.minor / whole.minor) * 100);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}