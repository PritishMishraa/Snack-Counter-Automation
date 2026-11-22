import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/domain/time.js';
import { completeRefill, expectDomainError, inr, makeApp, nok } from './helpers.js';

describe('budget check', () => {
  it('lets the buyer spend up to the single-purchase cap while there is plenty of budget', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('BLR', 'blr-1');
    const committed = await app.service.commit(refill.id, 'blr-1');
    expect(committed.commitment?.spendLimit).toEqual(inr(3000));
  });

  it('caps the spend limit at what is left this month, counting spent and reserved money', async () => {
    const app = makeApp();
    for (let i = 0; i < 4; i++) await completeRefill(app, 'OSL', `osl-${i + 1}`, nok(1150));
    const office = app.directory.office('OSL');
    expect((await app.service.budget(office)).remaining).toEqual(nok(1400));

    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    const c = await app.service.commit(refill.id, 'osl-1');
    expect(c.commitment?.spendLimit).toEqual(nok(1200));
    expect(await app.service.budget(office)).toMatchObject({ spent: nok(4600), reserved: nok(1200), remaining: nok(200) });

    await app.service.recordPurchase(refill.id, 'osl-1', { amount: nok(1100), receiptImage: 'r.jpg' });
    expect(await app.service.budget(office)).toMatchObject({ spent: nok(5700), reserved: nok(0), remaining: nok(300) });

    const next = await app.service.reportEmpty('OSL', 'osl-2');
    const c2 = await app.service.commit(next.refill.id, 'osl-2');
    expect(c2.commitment?.spendLimit).toEqual(nok(300));
  });

  it('puts the refill on hold when less than a minimum purchase is left, and tells the office and admins', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await completeRefill(app, 'OSL', `osl-${(i % 4) + 1}`, nok(1150));
    // 6000 - 5750 = 250 NOK left, below the 300 NOK minimum.
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    expect(refill.status).toBe('ON_HOLD_BUDGET');
    expect(app.chat.inChannel('#snacks-oslo').at(-1)?.text).toContain('budget for 2026-11 is used up');
    expect(app.chat.directTo('osl-admin').at(-1)?.text).toContain('on hold');
    await expectDomainError(app.service.commit(refill.id, 'osl-1'), 'BUDGET_EXCEEDED');
  });

  it('resumes an on-hold refill automatically when the new month starts (in the office time zone)', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await completeRefill(app, 'OSL', `osl-${(i % 4) + 1}`, nok(1150));
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');

    // 30 Nov 22:59 UTC is still November in Oslo (UTC+1).
    app.clock.set('2026-11-30T22:59:00Z');
    await app.service.tick();
    expect((await app.service.get(refill.id)).status).toBe('ON_HOLD_BUDGET');

    // 23:00 UTC is midnight in Oslo: December budget, but nobody is messaged until office hours.
    app.clock.set('2026-11-30T23:00:00Z');
    await app.service.tick();
    expect((await app.service.get(refill.id)).status).toBe('ON_HOLD_BUDGET');
    app.clock.set('2026-12-01T07:00:00Z'); // 08:00 Tuesday in Oslo
    await app.service.tick();
    const resumed = await app.service.get(refill.id);
    expect(resumed.status).toBe('AWAITING_VOLUNTEER');
    expect(resumed.offer?.to).toBeDefined();
    const c = await app.service.commit(refill.id, 'osl-1');
    expect(c.commitment?.budgetMonth).toBe('2026-12');
  });

  it('uses each office’s own time zone to decide the budget month', async () => {
    // 18:45 UTC on 30 Nov is 00:15 on 1 Dec in Bengaluru but still 19:45 on 30 Nov in Oslo.
    const app = makeApp({ start: '2026-11-30T18:45:00Z' });
    const blr = await completeRefill(app, 'BLR', 'blr-1', inr(1000));
    const osl = await completeRefill(app, 'OSL', 'osl-1', nok(500));
    expect(blr.purchase?.budgetMonth).toBe('2026-12');
    expect(osl.purchase?.budgetMonth).toBe('2026-11');
  });

  it('sends receipts above the limit to an admin before claiming', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    await app.service.commit(refill.id, 'osl-1');
    const bought = await app.service.recordPurchase(refill.id, 'osl-1', { amount: nok(1350), receiptImage: 'r.jpg' });
    expect(bought.status).toBe('NEEDS_APPROVAL');
    expect(app.hr.claims.size).toBe(0);
    // Still counts towards the budget: the money has been spent.
    expect((await app.service.budget(app.directory.office('OSL'))).spent).toEqual(nok(1350));

    await expectDomainError(app.service.approvePurchase(refill.id, 'osl-2'), 'NOT_ALLOWED');
    const approved = await app.service.approvePurchase(refill.id, 'osl-admin');
    expect(approved.status).toBe('CLAIM_SUBMITTED');
    expect(app.hr.claims.get(approved.claim!.claimId)?.request.amount).toBe('1350.00');
  });

  it('a rejected over-limit receipt no longer counts as spent', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    await app.service.commit(refill.id, 'osl-1');
    await app.service.recordPurchase(refill.id, 'osl-1', { amount: nok(2500), receiptImage: 'r.jpg' });
    await app.service.rejectPurchase(refill.id, 'osl-admin', 'that was a party, not a refill');
    expect((await app.service.budget(app.directory.office('OSL'))).spent).toEqual(nok(0));
  });

  it("rejects a purchase in the wrong currency (Oslo refills are bought in NOK)", async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    await app.service.commit(refill.id, 'osl-1');
    await expectDomainError(
      app.service.recordPurchase(refill.id, 'osl-1', { amount: inr(900), receiptImage: 'r.jpg' }),
      'CURRENCY_MISMATCH',
    );
  });

  it('budgets of the two offices are independent', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await completeRefill(app, 'OSL', `osl-${(i % 4) + 1}`, nok(1150));
    const blr = await app.service.reportEmpty('BLR', 'blr-1');
    expect(blr.refill.status).toBe('AWAITING_VOLUNTEER');
    const pos = await app.service.budget(app.directory.office('BLR'));
    expect(pos.remaining).toEqual(inr(15000));
  });

  it('a lapsed commitment releases its reservation', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    await app.service.commit(refill.id, 'osl-1');
    app.clock.advance(24 * HOUR);
    await app.service.tick();
    expect((await app.service.budget(app.directory.office('OSL'))).reserved).toEqual(nok(0));
  });
});
