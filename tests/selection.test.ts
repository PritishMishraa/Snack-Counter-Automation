import { describe, expect, it } from 'vitest';
import { DAY } from '../src/domain/time.js';
import { completeRefill, makeApp, nok } from './helpers.js';

const TODAY = '2026-11-02';

async function firstOfferFor(app: ReturnType<typeof makeApp>, officeId: string) {
  const { refill } = await app.service.reportEmpty(officeId, 'osl-4');
  return refill.offer?.to;
}

describe('choosing who buys', () => {
  it('prefers people who are confirmed in the office today over people with unknown status', async () => {
    const app = makeApp();
    app.directory.setPresence('osl-3', TODAY, { kind: 'office', officeId: 'OSL' });
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-3');
  });

  it('skips people who are on holiday or working remotely', async () => {
    const app = makeApp();
    app.directory.setPresence('osl-1', TODAY, { kind: 'holiday' });
    app.directory.setPresence('osl-2', TODAY, { kind: 'remote' });
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-3');
  });

  it('spreads the work: whoever has done the fewest refills recently is asked first', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(400));
    await completeRefill(app, 'OSL', 'osl-1', nok(400));
    // osl-1 now has 2 open claims; approve them so the open-claims rule doesn't hide the fairness rule.
    for (const c of app.hr.claims.values()) app.hr.approve(c.id);
    await app.service.tick();
    await completeRefill(app, 'OSL', 'osl-2', nok(400));
    await completeRefill(app, 'OSL', 'osl-3', nok(400));
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-4');
  });

  it('among people with equal counts, asks whoever refilled longest ago', async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-2', nok(400));
    app.clock.advance(DAY);
    await completeRefill(app, 'OSL', 'osl-1', nok(400));
    app.clock.advance(DAY);
    await completeRefill(app, 'OSL', 'osl-4', nok(400));
    app.clock.advance(DAY);
    await completeRefill(app, 'OSL', 'osl-3', nok(400));
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-2');
  });

  it('forgets refills older than the 30-day fairness window', async () => {
    const app = makeApp();
    for (const id of ['osl-2', 'osl-3', 'osl-4']) await completeRefill(app, 'OSL', id, nok(400));
    app.clock.advance(31 * DAY);
    await completeRefill(app, 'OSL', 'osl-1', nok(400));
    // osl-2..4 refilled 31 days ago (outside the window), osl-1 just now.
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-2');
  });

  it("does not ask people who are still waiting on two reimbursements, so nobody fronts too much money", async () => {
    const app = makeApp();
    await completeRefill(app, 'OSL', 'osl-1', nok(1000));
    app.clock.advance(31 * DAY);
    await completeRefill(app, 'OSL', 'osl-1', nok(1000));
    app.clock.advance(31 * DAY);
    // osl-1's refills are outside the fairness window, so only the open claims keep them out.
    for (const id of ['osl-2', 'osl-3', 'osl-4']) await completeRefill(app, 'OSL', id, nok(300));
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-2');
  });

  it('includes a visitor from the other office who checked in here today', async () => {
    const app = makeApp();
    app.directory.setPresence('blr-2', TODAY, { kind: 'office', officeId: 'OSL' });
    expect(await firstOfferFor(app, 'OSL')).toBe('blr-2');
  });

  it('does not ask a home volunteer who is visiting the other office', async () => {
    const app = makeApp();
    app.directory.setPresence('osl-1', TODAY, { kind: 'office', officeId: 'BLR' });
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-2');
    // ...and they are a candidate in Bengaluru instead.
    app.directory.setPresence('blr-1', TODAY, { kind: 'remote' });
    const { refill } = await app.service.reportEmpty('BLR', 'blr-3');
    expect(refill.offer?.to).toBe('osl-1');
  });

  it('never asks someone who is already committed to another refill', async () => {
    const app = makeApp();
    app.directory.setPresence('osl-1', TODAY, { kind: 'office', officeId: 'BLR' });
    const blr = await app.service.reportEmpty('BLR', 'blr-1');
    await app.service.commit(blr.refill.id, 'osl-1');
    app.directory.setPresence('osl-1', TODAY, { kind: 'office', officeId: 'OSL' });
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-2');
  });

  it('uses each volunteer’s usual office days: in the office ranks first, off-days count as remote', async () => {
    const app = makeApp();
    app.directory.setOfficeDays('osl-1', [2, 4]); // Tue, Thu; today is Monday
    app.directory.setOfficeDays('osl-3', [1, 3]); // Mon, Wed
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-3');
    const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
    await app.service.decline(refill.id, 'osl-3');
    // osl-1 is remote by pattern, so the next person is osl-2 (unknown), not osl-1.
    expect((await app.service.get(refill.id)).offer?.to).toBe('osl-2');
  });

  it('a one-off check-in beats the weekly pattern', async () => {
    const app = makeApp();
    app.directory.setOfficeDays('osl-1', [2, 4]);
    app.directory.setPresence('osl-1', TODAY, { kind: 'office', officeId: 'OSL' });
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-1');
  });

  it('a two-week visit to the other office covers every day of the trip, then reverts', async () => {
    const app = makeApp({ start: '2026-11-09T08:00:00Z' });
    app.directory.setOfficeDays('blr-1', [1, 2, 3, 4, 5]);
    app.directory.setPresenceRange('blr-1', '2026-11-09', '2026-11-20', { kind: 'office', officeId: 'OSL' });

    for (const day of ['2026-11-09', '2026-11-13', '2026-11-20']) {
      app.clock.set(`${day}T08:00:00Z`);
      const { refill } = await app.service.reportEmpty('OSL', 'osl-4');
      expect(refill.offer?.to, `Oslo on ${day}`).toBe('blr-1');
      const blr = await app.service.reportEmpty('BLR', 'blr-3');
      expect(blr.refill.offer?.to, `Bengaluru on ${day}`).not.toBe('blr-1');
      await app.service.cancel(refill.id, 'osl-4', 'test');
      await app.service.cancel(blr.refill.id, 'blr-3', 'test');
    }

    app.clock.set('2026-11-23T08:00:00Z'); // back home, Monday
    expect((await app.service.reportEmpty('BLR', 'blr-3')).refill.offer?.to).toBe('blr-1');
    expect((await app.service.reportEmpty('OSL', 'osl-4')).refill.offer?.to).not.toBe('blr-1');
  });

  it('ignores inactive volunteers', async () => {
    const app = makeApp();
    app.directory.upsertVolunteer({ employeeId: 'osl-1', name: 'Ada', homeOfficeId: 'OSL', active: false });
    expect(await firstOfferFor(app, 'OSL')).toBe('osl-2');
  });
});
