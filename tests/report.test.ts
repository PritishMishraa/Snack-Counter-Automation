import { describe, expect, it } from 'vitest';
import { budgetPosition } from '../src/core/budget.js';
import { renderReport } from '../src/core/report.js';
import { money } from '../src/domain/money.js';
import { DAY } from '../src/domain/time.js';
import { FixedRates } from '../src/fakes/support.js';
import { completeRefill, inr, makeApp, nok } from './helpers.js';

describe('monthly report: totals across both currencies', () => {
  it('totals each office exactly in its own currency and converts only the totals', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(1200), ['chips']);
    await completeRefill(app, 'OSL', 'osl-2', nok(850.5), ['chips', 'fruit']);
    await completeRefill(app, 'BLR', 'blr-1', inr(3000), ['samosa']);
    await completeRefill(app, 'BLR', 'blr-2', inr(2499.99), ['samosa', 'biscuits']);

    const r = await app.monthlyReport('2026-11');
    const [osl, blr] = r.offices;

    expect(osl!.spent).toEqual(nok(2050.5));
    expect(blr!.spent).toEqual(inr(5499.99));
    // 5 499.99 INR x 0.13 = 714.9987 NOK -> 715.00 NOK
    expect(blr!.spentConverted).toEqual(nok(715));
    expect(r.total.spent).toEqual(nok(2765.5));
    // 6 000 NOK + 15 000 INR x 0.13
    expect(r.total.budget).toEqual(nok(7950));
    expect(r.total.utilisationPct).toBe(34.8);
    expect(osl!.utilisationPct).toBe(34.2);
    expect(blr!.utilisationPct).toBe(36.7);
  });

  it('separates reimbursed, awaiting and rejected money, and excludes rejected from spent', async () => {
    const app = makeApp();
    const a = await completeRefill(app, 'OSL', 'osl-1', nok(500));
    const b = await completeRefill(app, 'OSL', 'osl-2', nok(400));
    await completeRefill(app, 'OSL', 'osl-3', nok(300));
    app.hr.approve(a.claim!.claimId);
    app.hr.reject(b.claim!.claimId, 'duplicate');
    await app.service.tick();

    const osl = (await app.monthlyReport('2026-11')).offices[0]!;
    expect(osl.reimbursed).toEqual(nok(500));
    expect(osl.awaitingReimbursement).toEqual(nok(300));
    expect(osl.rejected).toEqual(nok(400));
    expect(osl.spent).toEqual(nok(800));
    expect(osl.remaining).toEqual(nok(5200));
    expect(osl.refills).toBe(2);
  });

  it('agrees with the live budget check', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(999.99));
    await completeRefill(app, 'BLR', 'blr-1', inr(1234.56));
    const report = await app.monthlyReport('2026-11');
    const refills = await app.store.list();
    for (const o of report.offices) {
      expect(o.spent).toEqual(budgetPosition(app.directory.office(o.officeId), '2026-11', refills).spent);
    }
  });

  it('only includes the requested month', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(500));
    app.clock.advance(30 * DAY);
    await completeRefill(app, 'OSL', 'osl-2', nok(700));
    expect((await app.monthlyReport('2026-11')).offices[0]!.spent).toEqual(nok(500));
    expect((await app.monthlyReport('2026-12')).offices[0]!.spent).toEqual(nok(700));
  });

  it('a visitor buying in the other office is charged to that office, in its currency', async () => {
    const app = makeApp();
    app.directory.setPresence('blr-1', '2026-11-02', { kind: 'office', officeId: 'OSL' });
    const refill = await completeRefill(app, 'OSL', 'blr-1', nok(640));
    expect(app.hr.claims.get(refill.claim!.claimId)!.request).toMatchObject({
      employeeId: 'blr-1',
      amount: '640.00',
      currency: 'NOK',
    });
    const r = await app.monthlyReport('2026-11');
    expect(r.offices[0]!.spent).toEqual(nok(640));
    expect(r.offices[1]!.spent).toEqual(inr(0));
    expect(r.offices[0]!.refillsByVolunteer).toEqual({ 'blr-1': 1 });
  });

  it('can report in any currency using that month’s rate', async () => {
    const rates = new FixedRates({ 'NOK->EUR': 0.085, 'INR->EUR': 0.011 }, { '2026-12': { 'NOK->EUR': 0.09 } });
    const app = makeApp({ rates, reportingCurrency: 'EUR' });
    await completeRefill(app, 'OSL', 'osl-1', nok(1000));
    await completeRefill(app, 'BLR', 'blr-1', inr(2000));
    const r = await app.monthlyReport('2026-11');
    expect(r.offices[0]!.spentConverted).toEqual(money(85, 'EUR'));
    expect(r.offices[1]!.spentConverted).toEqual(money(22, 'EUR'));
    expect(r.total.spent).toEqual(money(107, 'EUR'));
  });

  it('shows how long the box stayed empty and which snacks are bought most', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-2');
    app.clock.advance(5 * 3_600_000);
    await app.service.commit(refill.id, 'osl-1');
    app.clock.advance(3_600_000);
    await app.service.recordPurchase(refill.id, 'osl-1', { amount: nok(500), receiptImage: 'r.jpg', items: ['chips', 'fruit'] });
    await completeRefill(app, 'OSL', 'osl-2', nok(500), ['chips']);

    const osl = (await app.monthlyReport('2026-11')).offices[0]!;
    expect(osl.avgHoursEmpty).toBe(3);
    expect(osl.topItems).toEqual([
      { item: 'chips', refills: 2 },
      { item: 'fruit', refills: 1 },
    ]);
  });

  it('is posted to the management channel as one message', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(500));
    const report = await app.sendMonthlyReport('2026-11');
    const msg = app.chat.inChannel('#snack-reports');
    expect(msg).toHaveLength(1);
    expect(msg[0]!.text).toBe(renderReport(report));
    expect(msg[0]!.text).toContain('Total: 500.00 NOK of 7,950.00 NOK');
  });
});
