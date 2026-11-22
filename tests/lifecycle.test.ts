import { describe, expect, it } from 'vitest';
import { HOUR, DAY } from '../src/domain/time.js';
import { completeRefill, expectDomainError, makeApp, nok } from './helpers.js';

describe('refill lifecycle: empty to reimbursed', () => {
  it('runs the happy path and files a correct HR claim', async () => {
    const app = makeApp();
    const { refill, created } = await app.service.reportEmpty('OSL', 'osl-3');
    expect(created).toBe(true);
    expect(refill.status).toBe('AWAITING_VOLUNTEER');
    expect(refill.offer?.to).toBe('osl-1');
    expect(app.chat.directTo('osl-1').at(-1)?.actions.map((a) => a.command)).toEqual([
      `/snack yes ${refill.id}`,
      `/snack no ${refill.id}`,
    ]);

    const committed = await app.service.commit(refill.id, 'osl-1');
    expect(committed.status).toBe('COMMITTED');
    expect(committed.commitment?.spendLimit).toEqual(nok(1200));

    const bought = await app.service.recordPurchase(refill.id, 'osl-1', {
      amount: nok(845.5),
      receiptImage: 'receipt.jpg',
      items: ['Chips', 'chips ', 'Kvikk Lunsj'],
    });
    expect(bought.status).toBe('CLAIM_SUBMITTED');
    expect(bought.purchase?.items).toEqual(['chips', 'kvikk lunsj']);

    const claim = app.hr.claims.get(bought.claim!.claimId)!;
    expect(claim.request).toEqual({
      employeeId: 'osl-1',
      amount: '845.50',
      currency: 'NOK',
      description: `Snack refill, Oslo office, 2026-11 [${refill.id}]: chips, kvikk lunsj`,
      receiptImage: 'receipt.jpg',
    });

    app.clock.advance(3 * DAY);
    app.hr.approve(claim.id);
    await app.service.tick();
    const done = await app.service.get(refill.id);
    expect(done.status).toBe('REIMBURSED');
    expect(app.chat.directTo('osl-1').at(-1)?.text).toContain('approved');
    expect(done.history.map((e) => e.type)).toEqual([
      'REPORTED_EMPTY',
      'OFFERED',
      'COMMITTED',
      'PURCHASED',
      'CLAIM_SUBMITTED',
      'REIMBURSED',
    ]);
  });

  it('a second empty report joins the existing refill instead of starting another', async () => {
    const app = makeApp();
    const first = await app.service.reportEmpty('OSL', 'osl-3');
    const second = await app.service.reportEmpty('OSL', 'osl-4');
    expect(second.created).toBe(false);
    expect(second.refill.id).toBe(first.refill.id);
    expect(app.chat.directTo('osl-4').at(-1)?.text).toContain('already reported empty');
  });

  it('simultaneous empty reports create exactly one refill', async () => {
    const app = makeApp();
    const results = await Promise.all(['osl-1', 'osl-2', 'osl-3', 'osl-4'].map((id) => app.service.reportEmpty('OSL', id)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.refill.id)).size).toBe(1);
    expect(await app.store.list()).toHaveLength(1);
  });

  it('each office has its own independent refill', async () => {
    const app = makeApp();
    const osl = await app.service.reportEmpty('OSL', 'osl-1');
    const blr = await app.service.reportEmpty('BLR', 'blr-1');
    expect(osl.created && blr.created).toBe(true);
    expect(blr.refill.offer?.to).toBe('blr-1');
  });

  it('a new refill can start once the previous one is bought, even while its claim is pending', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(500));
    const next = await app.service.reportEmpty('OSL', 'osl-2');
    expect(next.created).toBe(true);
  });
});

describe('two people cannot both commit to the same refill', () => {
  it('rejects a second commit after the first', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-3');
    await app.service.commit(refill.id, 'osl-2');
    const err = await expectDomainError(app.service.commit(refill.id, 'osl-1'), 'ALREADY_TAKEN');
    expect(err.message).toContain('Bjørn');
    expect((await app.service.get(refill.id)).commitment?.buyer).toBe('osl-2');
  });

  it('exactly one of many simultaneous commits wins', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-3');
    const people = ['osl-1', 'osl-2', 'osl-3', 'osl-4', 'blr-1'];
    const outcomes = await Promise.allSettled(people.map((p) => app.service.commit(refill.id, p)));

    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(people.length - 1);
    for (const l of losers) expect(l.reason.code).toBe('ALREADY_TAKEN');

    const stored = await app.service.get(refill.id);
    expect(stored.history.filter((e) => e.type === 'COMMITTED')).toHaveLength(1);
    // Only one person was told "you're on it".
    const confirmed = app.chat.messages.filter((m) => m.kind === 'direct' && m.text.startsWith("You're on it"));
    expect(confirmed).toHaveLength(1);
  });

  it('committing twice as the same person is harmless', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-3');
    const [a, b] = await Promise.all([app.service.commit(refill.id, 'osl-1'), app.service.commit(refill.id, 'osl-1')]);
    expect(a.commitment?.buyer).toBe('osl-1');
    expect(b.commitment?.buyer).toBe('osl-1');
  });

  it('only the committed buyer can report the purchase', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-3');
    await app.service.commit(refill.id, 'osl-1');
    await expectDomainError(
      app.service.recordPurchase(refill.id, 'osl-2', { amount: nok(400), receiptImage: 'r.jpg' }),
      'NOT_ALLOWED',
    );
  });

  it('anyone can step in while a direct offer is pending, and the person asked is told', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-3');
    expect(refill.offer?.to).toBe('osl-1');
    await app.service.commit(refill.id, 'osl-4');
    expect(app.chat.directTo('osl-1').at(-1)?.text).toContain('Never mind');
    await expectDomainError(app.service.commit(refill.id, 'osl-1'), 'ALREADY_TAKEN');
  });

  it('non-volunteers cannot commit', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-3');
    await expectDomainError(app.service.commit(refill.id, 'random-person'), 'NOT_ALLOWED');
  });
});

describe('a refill nobody completes is handed to someone else', () => {
  it('moves to the next candidate when an offer is not answered in time', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    expect(refill.offer?.to).toBe('osl-1');

    app.clock.advance(2 * HOUR - 1);
    await app.service.tick();
    expect((await app.service.get(refill.id)).offer?.to).toBe('osl-1');

    app.clock.advance(1);
    await app.service.tick();
    const after = await app.service.get(refill.id);
    expect(after.offer?.to).toBe('osl-2');
    expect(after.passedOver).toEqual(['osl-1']);
  });

  it('moves to the next candidate when someone declines', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    const after = await app.service.decline(refill.id, 'osl-1');
    expect(after.offer?.to).toBe('osl-2');
  });

  it('hands a committed refill on when the buyer misses the deadline, after reminding them', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.commit(refill.id, 'osl-1');

    app.clock.advance(18 * HOUR);
    await app.service.tick();
    expect(app.chat.directTo('osl-1').at(-1)?.text).toContain('Reminder');
    const budgetWhileCommitted = await app.service.budget(app.directory.office('OSL'));
    expect(budgetWhileCommitted.reserved).toEqual(nok(1200));

    app.clock.advance(6 * HOUR);
    await app.service.tick();
    const after = await app.service.get(refill.id);
    expect(after.status).toBe('AWAITING_VOLUNTEER');
    expect(after.commitment).toBeUndefined();
    expect(after.offer?.to).toBe('osl-2');
    expect(after.lapsedBuyer).toBe('osl-1');
    // The reservation is released so it does not block the budget.
    expect((await app.service.budget(app.directory.office('OSL'))).reserved).toEqual(nok(0));
  });

  it('a late buyer can still report their purchase if nobody else has committed', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.commit(refill.id, 'osl-1');
    app.clock.advance(25 * HOUR);
    await app.service.tick();

    const bought = await app.service.recordPurchase(refill.id, 'osl-1', { amount: nok(700), receiptImage: 'r.jpg' });
    expect(bought.status).toBe('CLAIM_SUBMITTED');
    expect(app.chat.directTo('osl-2').at(-1)?.text).toContain('Never mind');
  });

  it('a late buyer cannot report a purchase once someone else has committed (prevents double buying)', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.commit(refill.id, 'osl-1');
    app.clock.advance(25 * HOUR);
    await app.service.tick();
    await app.service.commit(refill.id, 'osl-2');
    expect(app.chat.directTo('osl-1').at(-1)?.text).toContain("Please don't buy");

    await expectDomainError(
      app.service.recordPurchase(refill.id, 'osl-1', { amount: nok(700), receiptImage: 'r.jpg' }),
      'NOT_ALLOWED',
    );
  });

  it('a buyer can release a refill they cannot do', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.commit(refill.id, 'osl-1');
    const after = await app.service.release(refill.id, 'osl-1');
    expect(after.status).toBe('AWAITING_VOLUNTEER');
    expect(after.offer?.to).toBe('osl-2');
  });

  it('opens the refill to the whole channel after three direct offers, then escalates to admins once', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.decline(refill.id, 'osl-1');
    await app.service.decline(refill.id, 'osl-2');
    const afterThird = await app.service.decline(refill.id, 'osl-3');
    expect(afterThird.offer?.to).toBeNull();
    expect(app.chat.inChannel('#snacks-oslo').at(-1)?.actions[0]?.command).toBe(`/snack yes ${refill.id}`);

    app.clock.advance(4 * HOUR);
    await app.service.tick();
    expect(app.chat.directTo('osl-admin')).toHaveLength(1);
    expect(app.chat.inChannel('#snacks-oslo').at(-1)?.text).toMatch(/^Still empty/);

    app.clock.advance(4 * HOUR);
    await app.service.tick();
    expect(app.chat.directTo('osl-admin')).toHaveLength(1);

    // Someone who declined earlier can still change their mind.
    const done = await app.service.commit(refill.id, 'osl-2');
    expect(done.status).toBe('COMMITTED');
  });

  it('broadcasts straight away when nobody is known to be available', async () => {
    const app = makeApp();
    const today = '2026-11-02';
    for (const id of ['osl-1', 'osl-2', 'osl-3', 'osl-4']) app.directory.setPresence(id, today, { kind: 'remote' });
    const { refill } = await app.service.reportEmpty('OSL', 'osl-1');
    expect(refill.offer?.to).toBeNull();
  });

  it('the reporter can cancel a false alarm', async () => {
    const app = makeApp();
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.commit(refill.id, 'osl-1');
    await expectDomainError(app.service.cancel(refill.id, 'osl-2', 'nope'), 'NOT_ALLOWED');
    const cancelled = await app.service.cancel(refill.id, 'osl-4', 'found a box in the kitchen');
    expect(cancelled.status).toBe('CANCELLED');
    expect(app.chat.directTo('osl-1').at(-1)?.text).toContain("Please don't buy");
  });
});

describe('reimbursement follow-up', () => {
  it('retries HR submission when the HR system is down, and tells admins after repeated failures', async () => {
    const app = makeApp();
    app.hr.failNext(3);
    const refill = await completeRefill(app, 'OSL', 'osl-1', nok(600));
    expect(refill.status).toBe('PURCHASED');

    await app.service.tick();
    await app.service.tick();
    expect((await app.service.get(refill.id)).claimAttempts).toBe(3);
    expect(app.chat.directTo('osl-admin').at(-1)?.text).toContain('failed 3 times');

    await app.service.tick();
    const after = await app.service.get(refill.id);
    expect(after.status).toBe('CLAIM_SUBMITTED');
    expect(app.hr.claims.size).toBe(1);
  });

  it('records an HR rejection and tells the buyer and admins', async () => {
    const app = makeApp();
    const refill = await completeRefill(app, 'OSL', 'osl-1', nok(600));
    app.hr.reject(refill.claim!.claimId, 'receipt unreadable');
    await app.service.tick();
    const after = await app.service.get(refill.id);
    expect(after.status).toBe('CLAIM_REJECTED');
    expect(after.claim?.rejectionReason).toBe('receipt unreadable');
    expect(app.chat.directTo('osl-admin').at(-1)?.text).toContain('receipt unreadable');
  });

  it('one refill failing to reach HR does not stop the scheduler handling the others', async () => {
    const app = makeApp();
    const claimed = await completeRefill(app, 'OSL', 'osl-1', nok(600));
    const { refill: open } = await app.service.reportEmpty('BLR', 'blr-1');
    app.hr.failStatusNext(1);
    app.clock.advance(2 * HOUR);

    const failures = await app.service.tick();
    expect(failures.map((f) => f.refillId)).toEqual([claimed.id]);
    expect((await app.service.get(open.id)).offer?.to).toBe('blr-2');

    app.hr.approve(claimed.claim!.claimId);
    expect(await app.service.tick()).toEqual([]);
    expect((await app.service.get(claimed.id)).status).toBe('REIMBURSED');
  });

  it('chases claims that HR has not decided within 10 days, once', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(600));
    app.clock.advance(10 * DAY + HOUR);
    await app.service.tick();
    await app.service.tick();
    const chases = app.chat.directTo('osl-admin').filter((m) => m.text.includes('pending for over 10 days'));
    expect(chases).toHaveLength(1);
  });
});
