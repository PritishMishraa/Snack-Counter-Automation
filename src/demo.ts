/**
 * A scripted month at both offices, printed as the chat transcript people would see.
 * Run with: npm run demo
 */
import { createSnackApp } from './app.js';
import type { Volunteer } from './domain/model.js';
import { money } from './domain/money.js';
import { DAY, HOUR, MINUTE } from './domain/time.js';

const volunteers: Volunteer[] = [
  ...['Ada', 'Bjørn', 'Camilla', 'Dag', 'Eirin'].map((name, i) => ({ employeeId: `osl-${i + 1}`, name, homeOfficeId: 'OSL', active: true })),
  ...['Anil', 'Bhavna', 'Chetan', 'Divya', 'Esha'].map((name, i) => ({ employeeId: `blr-${i + 1}`, name, homeOfficeId: 'BLR', active: true })),
];

const app = createSnackApp({ start: '2026-11-02T07:30:00Z', volunteers });
const { clock, chat, commands, service, hr } = app;

chat.onMessage((m) => {
  const where = m.kind === 'channel' ? m.to : `DM → ${app.directory.volunteer(m.to)?.name ?? m.to}`;
  const buttons = m.actions.length ? `   [${m.actions.map((a) => a.label).join('] [')}]` : '';
  console.log(`  ${stamp()}  ${where.padEnd(20)} ${m.text}${buttons}`);
});

async function say(who: string, text: string): Promise<void> {
  const name = app.directory.volunteer(who)?.name ?? who;
  console.log(`  ${stamp()}  ${name.padEnd(20)} > ${text}`);
  const reply = await commands.handle(who, text);
  console.log(`  ${stamp()}  ${'bot → ' + name.padEnd(14)} ${reply.split('\n')[0]}`);
}

/** Moves time forward in 15-minute steps, running the scheduler like a cron job would. */
async function passTime(ms: number): Promise<void> {
  const end = clock.now().getTime() + ms;
  while (clock.now().getTime() < end) {
    clock.advance(Math.min(15 * MINUTE, end - clock.now().getTime()));
    hr.approveOlderThan(3 * DAY);
    await service.tick();
  }
}

function stamp(): string {
  return clock.now().toISOString().slice(5, 16).replace('T', ' ');
}

function scene(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 76 - title.length))}`);
}

scene('1. Oslo: box empty, the first person asked does not answer');
await say('osl-2', '/snack here');
await say('osl-1', '/snack holiday 2026-11-02 2026-11-06');
await say('osl-3', '/snack empty');
await passTime(2 * HOUR + 5 * MINUTE);
await say('osl-3', '/snack yes R-OSL-1');
await passTime(3 * HOUR);
await say('osl-3', '/snack bought R-OSL-1 845.50 https://receipts/osl-1.jpg chips, kvikk lunsj, fruit');

scene('2. Bengaluru: two people press the button at the same moment');
await say('blr-3', '/snack empty');
const results = await Promise.all([commands.handle('blr-1', '/snack yes R-BLR-1'), commands.handle('blr-2', '/snack yes R-BLR-1')]);
console.log(`  ${stamp()}  Anil and Bhavna both pressed "Yes". Replies: "${results[0]}" | "${results[1]}"`);
await passTime(2 * HOUR);
const blrBuyer = (await service.get('R-BLR-1')).commitment!.buyer;
await say(blrBuyer, '/snack bought R-BLR-1 2450 https://receipts/blr-1.jpg samosa, biscuits, banana chips');

scene('3. Oslo: someone commits, then forgets; the refill is handed on');
await passTime(18 * HOUR); // Tuesday morning
await say('osl-4', '/snack empty');
await say('osl-4', '/snack yes R-OSL-2');
await passTime(24 * HOUR + 15 * MINUTE);
await say('osl-5', '/snack yes R-OSL-2');
await say('osl-5', '/snack bought R-OSL-2 1120 https://receipts/osl-2.jpg chips, cola');

scene('4. A Bengaluru volunteer visiting Oslo for a week refills there');
await passTime(DAY); // Thursday
await say('blr-1', '/snack visiting oslo 2026-11-05 2026-11-13');
await say('osl-2', '/snack empty');
await say('blr-1', '/snack yes R-OSL-3');
await say('blr-1', '/snack bought R-OSL-3 690 https://receipts/osl-3.jpg fruit, nuts');

scene('5. Over the limit: an admin has to approve');
await passTime(DAY); // Friday
await say('blr-4', '/snack empty');
await say('blr-4', '/snack yes R-BLR-2');
await say('blr-4', '/snack bought R-BLR-2 3400 https://receipts/blr-2.jpg samosa, juice');
await say('blr-admin', '/snack approve R-BLR-2');

scene('6. End of month: HR has approved everything older than three days');
await passTime(10 * DAY);
await say('osl-1', '/snack status oslo');
clock.set('2026-12-01T06:00:00Z');
await app.sendMonthlyReport('2026-11');
