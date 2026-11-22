import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/chat/commands.js';
import { makeApp } from './helpers.js';

describe('chat commands', () => {
  it('drives a whole refill through slash commands and buttons', async () => {
    const app = makeApp();
    const say = (who: string, text: string) => app.commands.handle(who, text);

    expect(await say('osl-2', '/snack here')).toContain('Oslo');
    expect(await say('osl-4', '/snack empty')).toContain('refill R-OSL-1 started');
    // osl-2 checked in, so is asked first; they press the button from their DM.
    const button = app.chat.directTo('osl-2').at(-1)!.actions[0]!.command;
    expect(await say('osl-2', button)).toContain('it is yours');
    expect(await say('osl-1', '/snack yes R-OSL-1')).toContain('Bjørn is already refilling');
    expect(await say('osl-2', '/snack bought R-OSL-1 845,50 https://img/r1.jpg chips, kvikk lunsj')).toContain('claim has been filed');

    const refill = await app.service.get('R-OSL-1');
    expect(refill.purchase?.amount).toEqual({ minor: 84550, currency: 'NOK' });
    expect(refill.purchase?.items).toEqual(['chips', 'kvikk lunsj']);
    expect(await say('osl-1', '/snack status')).toContain('845.50 NOK spent');
  });

  it('reports empty for the office the person is visiting', async () => {
    const app = makeApp();
    await app.commands.handle('blr-1', '/snack here oslo');
    expect(await app.commands.handle('blr-1', '/snack empty')).toContain('Oslo');
  });

  it('holiday dates make someone ineligible', async () => {
    const app = makeApp();
    await app.commands.handle('osl-1', '/snack holiday 2026-11-01 2026-11-06');
    await app.commands.handle('osl-4', '/snack empty');
    expect((await app.service.get('R-OSL-1')).offer?.to).toBe('osl-2');
  });

  it('sets usual office days and trips with one command each', async () => {
    const app = makeApp();
    expect(await app.commands.handle('osl-1', '/snack days tue,thursday')).toContain('Tue, Thu');
    expect(app.directory.usualOfficeDays('osl-1')).toEqual([2, 4]);
    expect(await app.commands.handle('blr-1', '/snack visiting oslo 2026-11-02 2026-11-13')).toContain("won't ask you in Bengaluru");
    expect(app.directory.presenceOn('blr-1', '2026-11-13')).toEqual({ kind: 'office', officeId: 'OSL' });
    expect(app.directory.presenceOn('blr-1', '2026-11-14')).toBeUndefined();
    expect(await app.commands.handle('osl-1', '/snack days none')).toContain('Cleared');
    expect(await app.commands.handle('osl-1', '/snack days funday')).toContain('not a weekday');
    expect(await app.commands.handle('osl-1', '/snack holiday 2026-11-10 2026-11-01')).toContain('before the start');
  });

  it('turns errors into friendly replies', async () => {
    const app = makeApp();
    expect(await app.commands.handle('osl-1', '/snack yes R-NOPE')).toContain('No refill R-NOPE');
    expect(await app.commands.handle('osl-1', '/snack dance')).toContain('Unknown command');
    expect(await app.commands.handle('osl-1', '/snack holiday tomorrow')).toContain('not a date');
  });

  it('parses amounts with a dot or comma', () => {
    expect(parseAmount('450')).toBe(45000);
    expect(parseAmount('450.5')).toBe(45050);
    expect(parseAmount('450,05')).toBe(45005);
    expect(() => parseAmount('4.5.0')).toThrow();
    expect(() => parseAmount('-10')).toThrow();
  });
});
