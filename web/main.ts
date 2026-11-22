/**
 * Interactive simulation of the snack bot, running the real core logic from src/ in the browser.
 * Every action goes through the same /snack chat commands a person would type, and every message in
 * the feed is one the bot actually sent through the simulated chat tool.
 */
import { createSnackApp, type SnackApp } from '../src/app.js';
import { WEEKDAYS } from '../src/chat/commands.js';
import { budgetPosition } from '../src/core/budget.js';
import { rankCandidates } from '../src/core/selection.js';
import { ACTIVE_STATUSES, type EmployeeId, type Office, type Refill, type Volunteer } from '../src/domain/model.js';
import { format, type Money } from '../src/domain/money.js';
import { DAY, HOUR, MINUTE, formatLocal, localDate, localMonth, type Weekday } from '../src/domain/time.js';
import type { SentMessage } from '../src/fakes/fake-chat.js';

const START = '2026-11-02T08:00:00Z'; // Monday 09:00 in Oslo, 13:30 in Bengaluru

const VOLUNTEERS: Volunteer[] = [
  ...['Ada', 'Bjørn', 'Camilla', 'Dag', 'Eirin', 'Fredrik'].map((name, i) => ({ employeeId: `osl-${i + 1}`, name, homeOfficeId: 'OSL', active: true })),
  ...['Anil', 'Bhavna', 'Chetan', 'Divya', 'Esha', 'Farhan', 'Gauri'].map((name, i) => ({ employeeId: `blr-${i + 1}`, name, homeOfficeId: 'BLR', active: true })),
];
const ADMINS: Record<string, string> = { 'osl-admin': 'Oslo office manager', 'blr-admin': 'Bengaluru office manager' };

/** Hybrid patterns: [employee, usual office days (0 = Sun)]. People without one stay "unknown". */
const PATTERNS: Array<[EmployeeId, Weekday[]]> = [
  ['osl-1', [1, 2, 4]],
  ['osl-2', [1, 3]],
  ['osl-3', [2, 3, 4]],
  ['osl-5', [1, 2, 3, 4, 5]],
  ['osl-6', [3, 5]],
  ['blr-1', [1, 2, 3, 4, 5]],
  ['blr-2', [1, 3, 5]],
  ['blr-3', [2, 4]],
  ['blr-5', [1, 2, 3, 4]],
  ['blr-7', [1, 2]],
];

type FeedEntry =
  | { kind: 'msg'; at: Date; msg: SentMessage }
  | { kind: 'user'; at: Date; who: EmployeeId; text: string; reply?: string }
  | { kind: 'note'; at: Date; text: string };

let app: SnackApp;
let feed: FeedEntry[] = [];
let feedFilter: 'all' | 'channels' | 'dms' = 'all';
let hrAutoApprove = true;
let actingAs: EmployeeId = 'osl-4';
let busy = false;
let scenarioTitle = '';
const drafts = new Map<string, string>();
const root = document.getElementById('app')!;

function reset(): void {
  app = createSnackApp({ start: START, volunteers: VOLUNTEERS });
  feed = [];
  drafts.clear();
  scenarioTitle = '';
  app.chat.onMessage((msg) => feed.push({ kind: 'msg', at: app.clock.now(), msg }));
  for (const [id, days] of PATTERNS) app.directory.setOfficeDays(id, days);
  app.directory.setPresenceRange('osl-5', '2026-11-02', '2026-11-06', { kind: 'holiday' });
}

// ─── Acting in the simulation ─────────────────────────────────────────────────

async function say(who: EmployeeId, text: string): Promise<string> {
  const entry: FeedEntry = { kind: 'user', at: app.clock.now(), who, text };
  feed.push(entry);
  entry.reply = await app.commands.handle(who, text);
  return entry.reply;
}

function note(text: string): void {
  feed.push({ kind: 'note', at: app.clock.now(), text });
}

/** Moves time forward in 15-minute steps, running the scheduler each step, as a cron job would. */
async function advance(ms: number): Promise<void> {
  const end = app.clock.now().getTime() + ms;
  while (app.clock.now().getTime() < end) {
    app.clock.advance(Math.min(15 * MINUTE, end - app.clock.now().getTime()));
    if (hrAutoApprove) app.hr.approveOlderThan(3 * DAY);
    await app.service.tick();
  }
}

async function advanceTo(iso: string): Promise<void> {
  await advance(new Date(iso).getTime() - app.clock.now().getTime());
}

async function active(officeId: string): Promise<Refill | undefined> {
  return app.store.findActive(officeId);
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, { title: string; run: () => Promise<void> }> = {
  race: {
    title: 'Two people tap “Yes” at the same moment',
    async run() {
      note('Dag finds the Oslo box empty. Ada and Bjørn both see the channel post and tap “Yes” within milliseconds.');
      await say('osl-4', '/snack empty');
      const r = (await active('OSL'))!;
      await Promise.all([say('osl-1', `/snack yes ${r.id}`), say('osl-2', `/snack yes ${r.id}`)]);
      note('Exactly one commit wins (compare-and-set on the refill version). The other is told not to buy.');
    },
  },
  silence: {
    title: 'Nobody answers',
    async run() {
      note('The box is reported empty, and nobody answers their DM.');
      await say('osl-4', '/snack empty');
      for (let i = 0; i < 3; i++) await advance(2 * HOUR);
      note('After three unanswered 2-hour offers, the refill is opened to the whole #snacks-oslo channel.');
      await advance(4 * HOUR);
      note('Still nobody after 4 hours: the channel is re-posted and the office manager is alerted.');
    },
  },
  lapse: {
    title: 'Buyer commits, then forgets',
    async run() {
      await say('osl-4', '/snack empty');
      const r = (await active('OSL'))!;
      await say(r.offer!.to!, `/snack yes ${r.id}`);
      note('The buyer has 24 hours. Fast-forward 18 hours…');
      await advance(18 * HOUR);
      note('…a reminder went out. Another 6 hours pass without a purchase.');
      await advance(6 * HOUR);
      note('The refill is handed to the next person and the budget reservation is released. The first buyer can still report a late purchase until someone else commits.');
    },
  },
  visitor: {
    title: 'A Bengaluru volunteer visits Oslo for two weeks',
    async run() {
      note('Anil will be in Oslo for two weeks. One command covers the whole trip, with no daily check-ins.');
      await say('blr-1', '/snack visiting oslo 2026-11-02 2026-11-13');
      await say('osl-4', '/snack empty');
      await say('blr-3', '/snack empty');
      note('Anil is a candidate in Oslo (he is physically there) and is skipped in Bengaluru, even though he is usually in on weekdays. If he buys in Oslo it is charged to Oslo’s NOK budget; HR pays him in INR.');
    },
  },
  budget: {
    title: 'The monthly budget runs out',
    async run() {
      note('Five Oslo refills of 1 150 NOK use 5 750 of the 6 000 NOK budget…');
      const buyers = ['osl-1', 'osl-2', 'osl-3', 'osl-4', 'osl-6'];
      for (const b of buyers) {
        await say('osl-4', '/snack empty');
        const r = (await active('OSL'))!;
        await say(b, `/snack yes ${r.id}`);
        await say(b, `/snack bought ${r.id} 1150 https://receipts/${r.id}.jpg chips, fruit`);
        await advance(4 * HOUR);
      }
      await say('osl-4', '/snack empty');
      note('Only 250 NOK is left, below a sensible minimum purchase (300 NOK), so the refill is put on hold and the office manager is told. Try “Jump to 1 Dec”: it resumes automatically.');
    },
  },
  overLimit: {
    title: 'A receipt above the limit',
    async run() {
      await say('osl-4', '/snack empty');
      const r = (await active('OSL'))!;
      await say(r.offer!.to!, `/snack yes ${r.id}`);
      await say(r.offer!.to!, `/snack bought ${r.id} 1480 https://receipts/${r.id}.jpg cake, coffee`);
      note('1 480 NOK is above the 1 200 NOK pre-approved limit. It counts as spent, but the HR claim waits for the office manager. Approve or reject it under “Back office”.');
    },
  },
  month: {
    title: 'Simulate the whole of November',
    async run() {
      note('Simulating every working day of November at both offices: random empty boxes, some declines and timeouts, purchases within the typical range. HR approves claims after 3 days.');
      await simulateMonth();
      note('Done. The management report below now covers the whole month.');
    },
  },
};

/** Deterministic pseudo-random numbers, so the month simulation is the same every time. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function simulateMonth(): Promise<void> {
  const rand = rng(42);
  const items: Record<string, string[]> = {
    OSL: ['chips', 'fruit', 'kvikk lunsj', 'nuts', 'cola', 'knekkebrød'],
    BLR: ['samosa', 'biscuits', 'banana chips', 'chikki', 'juice', 'fruit'],
  };
  for (let day = 2; day <= 30; day++) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    await advanceTo(`${date}T07:30:00Z`);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const office of app.directory.listOffices()) {
      if (rand() > 0.42 || (await active(office.id))) continue;
      const locals = VOLUNTEERS.filter((v) => v.homeOfficeId === office.id);
      await say(locals[Math.floor(rand() * locals.length)]!.employeeId, `/snack empty ${office.id}`);
      for (let attempt = 0; attempt < 6; attempt++) {
        const r = await active(office.id);
        if (!r || r.status !== 'AWAITING_VOLUNTEER') break;
        const who = r.offer?.to ?? locals[Math.floor(rand() * locals.length)]!.employeeId;
        const roll = rand();
        if (roll < 0.65) {
          await say(who, `/snack yes ${r.id}`);
          break;
        }
        if (roll < 0.85) await say(who, `/snack no ${r.id}`);
        else await advance(2 * HOUR);
      }
      const r = await active(office.id);
      if (r?.status !== 'COMMITTED') continue;
      const buyer = r.commitment!.buyer;
      const [lo, hi] = office.currency === 'NOK' ? [350, 1150] : [600, 2900];
      // Buyers stay within the limit the bot gave them (the over-limit path has its own scenario).
      const limit = r.commitment!.spendLimit.minor / 100;
      const amount = Math.min(Math.round((lo + rand() * (hi - lo)) / 10) * 10, Math.floor(limit));
      const picked = items[office.id]!.filter(() => rand() < 0.4).join(', ') || items[office.id]![0]!;
      await advance(HOUR);
      await say(buyer, `/snack bought ${r.id} ${amount} https://receipts/${r.id}.jpg ${picked}`);
    }
  }
  await advanceTo('2026-11-30T17:00:00Z');
}

// ─── Derived view data ────────────────────────────────────────────────────────

function personName(id: EmployeeId): string {
  return app.directory.volunteer(id)?.name ?? ADMINS[id] ?? id;
}

function officeName(id: string): string {
  return app.directory.office(id).name;
}

interface PersonStats {
  recent: number;
  owed: number;
}

function statsFor(id: EmployeeId, refills: readonly Refill[], now: Date): PersonStats {
  const bought = refills.filter((r) => r.purchase?.buyer === id);
  return {
    recent: bought.filter((r) => r.purchase!.purchasedAt.getTime() >= now.getTime() - app.policy.fairnessWindowMs).length,
    owed: bought.filter((r) => ['NEEDS_APPROVAL', 'PURCHASED', 'CLAIM_SUBMITTED'].includes(r.status)).length,
  };
}

function presenceKey(id: EmployeeId, date: string): string {
  const p = app.directory.presenceOn(id, date);
  if (!p) return 'unknown';
  return p.kind === 'office' ? `office:${p.officeId}` : p.kind;
}

function presenceLabel(key: string): string {
  if (key.startsWith('office:')) return `In ${officeName(key.slice(7))}`;
  return { unknown: 'Unknown', remote: 'Remote', holiday: 'On holiday' }[key] ?? key;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function h(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function when(d: Date, office: Office): string {
  return formatLocal(d, office.timeZone);
}

async function render(): Promise<void> {
  const refills = await app.store.list();
  const now = app.clock.now();
  const [osl, blr] = app.directory.listOffices() as [Office, Office];
  const report = await app.monthlyReport(localMonth(now, osl.timeZone));

  root.innerHTML = `
    <section class="controls">
      <div class="clock">
        <div class="clock-main">${h(formatLocal(now, osl.timeZone))} <span>Oslo</span></div>
        <div class="clock-sub">${h(formatLocal(now, blr.timeZone))} Bengaluru</div>
      </div>
      <div class="btn-group" role="group" aria-label="Advance time">
        <button data-act="advance" data-ms="${15 * MINUTE}">+15 min</button>
        <button data-act="advance" data-ms="${2 * HOUR}">+2 h</button>
        <button data-act="advance" data-ms="${6 * HOUR}">+6 h</button>
        <button data-act="advance" data-ms="${DAY}">+1 day</button>
        <button data-act="jump-month">Jump to 1 Dec</button>
      </div>
      <label class="toggle"><input type="checkbox" data-act="hr-auto" ${hrAutoApprove ? 'checked' : ''}/> HR approves claims after 3 days</label>
      <button class="ghost" data-act="reset">Reset</button>
    </section>

    <section class="scenarios">
      <span class="scenarios-label">Try a scenario</span>
      ${Object.entries(SCENARIOS)
        .map(([k, s]) => `<button class="chip-btn ${scenarioTitle === s.title ? 'on' : ''}" data-act="scenario" data-key="${k}">${h(s.title)}</button>`)
        .join('')}
    </section>

    <div class="layout">
      <div class="col-main">
        ${officeCard(osl, refills, now)}
        ${officeCard(blr, refills, now)}
        ${backOffice(refills)}
        ${reportPanel(report)}
      </div>
      <aside class="col-feed">${feedPanel()}</aside>
    </div>`;

  const list = root.querySelector('.feed-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function officeCard(office: Office, refills: readonly Refill[], now: Date): string {
  const today = localDate(now, office.timeZone);
  const refill = refills.find((r) => r.officeId === office.id && ACTIVE_STATUSES.has(r.status));
  const pos = budgetPosition(office, localMonth(now, office.timeZone), refills);
  const ranked = rankCandidates({
    office,
    today,
    now,
    volunteers: app.directory.listVolunteers(),
    presenceOn: (id, d) => app.directory.presenceOn(id, d),
    refills,
    exclude: new Set(refill?.passedOver ?? []),
    policy: app.policy,
  });
  const rank = new Map(ranked.map((c, i) => [c.employeeId, i + 1]));
  const busyElsewhere = new Set(refills.filter((r) => r.status === 'COMMITTED' && r.officeId !== office.id).map((r) => r.commitment!.buyer));

  const people = VOLUNTEERS.filter((v) => {
    const key = presenceKey(v.employeeId, today);
    return v.homeOfficeId === office.id || key === `office:${office.id}`;
  });

  const pct = (m: Money) => Math.max(0, Math.min(100, (m.minor / pos.budget.minor) * 100));

  return `
  <section class="card office">
    <header class="office-head">
      <div>
        <h2>${h(office.name)} <small>${h(office.currency)} · ${h(office.channel)}</small></h2>
        <div class="box-line">${boxStatus(office, refill)}</div>
      </div>
      <button class="primary" data-act="empty" data-office="${office.id}" ${refill ? 'disabled' : ''}>Report box empty</button>
    </header>

    <div class="budget" aria-label="Budget">
      <div class="bar">
        <span class="spent" style="width:${pct(pos.spent)}%"></span><span class="reserved" style="width:${pct(pos.reserved)}%"></span>
      </div>
      <div class="budget-legend">
        <span><i class="dot spent"></i>${h(format(pos.spent))} spent</span>
        <span><i class="dot reserved"></i>${h(format(pos.reserved))} reserved</span>
        <span class="${pos.remaining.minor < office.minPurchase.minor ? 'low' : ''}"><b>${h(format(pos.remaining))}</b> left of ${h(format(pos.budget))} in ${h(pos.month)}</span>
      </div>
    </div>

    <table class="people">
      <thead><tr><th>Volunteer</th><th>Today</th><th>Usual days</th><th class="num">Refills (30 d)</th><th class="num">Owed</th><th>Who's asked next</th><th></th></tr></thead>
      <tbody>${people.map((v) => personRow(v, office, today, refill, refills, now, rank, busyElsewhere)).join('')}</tbody>
    </table>
  </section>`;
}

function boxStatus(office: Office, r: Refill | undefined): string {
  if (!r) return `<span class="pill ok">Stocked</span>`;
  switch (r.status) {
    case 'AWAITING_VOLUNTEER':
      return r.offer?.to
        ? `<span class="pill warn">Empty</span> Asked <b>${h(personName(r.offer.to))}</b>, who has until ${h(when(r.offer.expiresAt, office))} to answer · ${r.id}`
        : `<span class="pill warn">Empty</span> Open to everyone in ${h(office.channel)} until ${h(when(r.offer?.expiresAt ?? new Date(), office))}${r.escalated ? ' · <b>manager alerted</b>' : ''} · ${r.id}`;
    case 'COMMITTED':
      return `<span class="pill info">Being refilled</span> <b>${h(personName(r.commitment!.buyer))}</b> is buying, up to ${h(format(r.commitment!.spendLimit))}, by ${h(when(r.commitment!.dueAt, office))} · ${r.id}`;
    case 'ON_HOLD_BUDGET':
      return `<span class="pill bad">On hold</span> This month's budget is used up. Resumes automatically next month · ${r.id}`;
    default:
      return '';
  }
}

function personRow(
  v: Volunteer,
  office: Office,
  today: string,
  r: Refill | undefined,
  refills: readonly Refill[],
  now: Date,
  rank: Map<EmployeeId, number>,
  busyElsewhere: Set<EmployeeId>,
): string {
  const id = v.employeeId;
  const key = presenceKey(id, today);
  const s = statsFor(id, refills, now);
  const days = app.directory.usualOfficeDays(id);
  const visitor = v.homeOfficeId !== office.id;
  const away = key.startsWith('office:') && key !== `office:${office.id}`;

  let next: string;
  const n = rank.get(id);
  if (n !== undefined) next = n === 1 ? `<span class="pill info">1st</span>` : `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  else if (r?.passedOver.includes(id)) next = '<span class="muted">passed this time</span>';
  else if (key === 'holiday' || key === 'remote' || away) next = `<span class="muted">skipped: ${h(presenceLabel(key).toLowerCase())}</span>`;
  else if (s.owed >= app.policy.maxOpenClaimsPerVolunteer) next = `<span class="muted">skipped: owed for ${s.owed} refills</span>`;
  else if (busyElsewhere.has(id) || (r?.status === 'COMMITTED' && r.commitment!.buyer === id)) next = '<span class="muted">buying</span>';
  else next = '<span class="muted">-</span>';

  const options = ['unknown', 'office:OSL', 'office:BLR', 'remote', 'holiday']
    .map((k) => `<option value="${k}" ${k === key ? 'selected' : ''}>${h(k === 'unknown' && days ? 'Usual pattern' : presenceLabel(k))}</option>`)
    .join('');

  return `
  <tr class="${away ? 'away' : ''} ${r?.offer?.to === id ? 'asked' : ''}">
    <td><b>${h(v.name)}</b>${visitor ? ` <span class="tag">from ${h(officeName(v.homeOfficeId))}</span>` : ''}</td>
    <td><select data-act="presence" data-who="${id}" data-office="${office.id}" aria-label="${h(v.name)} today">${options}</select></td>
    <td class="muted">${days ? days.map((d) => WEEKDAYS[d]).join(' ') : '-'}</td>
    <td class="num">${s.recent}</td>
    <td class="num">${s.owed || '-'}</td>
    <td>${next}</td>
    <td class="actions">${away ? '' : personActions(id, office, r)}</td>
  </tr>`;
}

function personActions(id: EmployeeId, office: Office, r: Refill | undefined): string {
  if (!r) return '';
  if (r.status === 'AWAITING_VOLUNTEER') {
    if (r.offer?.to === id) {
      return `<button class="small ok" data-act="cmd" data-who="${id}" data-cmd="/snack yes ${r.id}">Yes, I'll buy</button>
              <button class="small" data-act="cmd" data-who="${id}" data-cmd="/snack no ${r.id}">Can't today</button>`;
    }
    if (r.lapsedBuyer === id) return boughtForm(id, office, r, 'Report late purchase');
    return `<button class="small" data-act="cmd" data-who="${id}" data-cmd="/snack yes ${r.id}">Step in</button>`;
  }
  if (r.status === 'COMMITTED' && r.commitment!.buyer === id) {
    return `${boughtForm(id, office, r, 'Bought')}<button class="small" data-act="cmd" data-who="${id}" data-cmd="/snack release ${r.id}">Release</button>`;
  }
  return '';
}

function boughtForm(id: EmployeeId, office: Office, r: Refill, label: string): string {
  const amountKey = `amount:${r.id}`;
  const itemsKey = `items:${r.id}`;
  const amount = drafts.get(amountKey) ?? (office.currency === 'NOK' ? '845.50' : '2450');
  const items = drafts.get(itemsKey) ?? (office.currency === 'NOK' ? 'chips, fruit' : 'samosa, biscuits');
  return `<span class="bought">
    <input class="amt" data-draft="${amountKey}" value="${h(amount)}" aria-label="Amount in ${office.currency}" />
    <input class="items" data-draft="${itemsKey}" value="${h(items)}" aria-label="Items" />
    <button class="small ok" data-act="bought" data-who="${id}" data-refill="${r.id}">${h(label)}</button>
  </span>`;
}

function backOffice(refills: readonly Refill[]): string {
  const approvals = refills.filter((r) => r.status === 'NEEDS_APPROVAL');
  const claims = [...app.hr.claims.values()].reverse();
  const now = app.clock.now().getTime();
  return `
  <section class="card">
    <h2>Back office <small>office managers and the simulated HR system</small></h2>
    ${
      approvals.length
        ? approvals
            .map((r) => {
              const admin = app.directory.office(r.officeId).admins[0]!;
              return `<div class="approval"><span class="pill warn">Needs approval</span>
                <b>${h(personName(r.purchase!.buyer))}</b> spent ${h(format(r.purchase!.amount))} on ${r.id}, above the ${h(format(r.commitment?.spendLimit ?? app.directory.office(r.officeId).maxPurchase))} limit
                <span class="spacer"></span>
                <button class="small ok" data-act="cmd" data-who="${admin}" data-cmd="/snack approve ${r.id}">Approve as manager</button>
                <button class="small" data-act="cmd" data-who="${admin}" data-cmd="/snack reject ${r.id} not a snack refill">Reject</button></div>`;
            })
            .join('')
        : ''
    }
    ${
      claims.length
        ? `<table class="claims"><thead><tr><th>HR claim</th><th>Employee</th><th class="num">Amount</th><th>Description</th><th>Age</th><th>Status</th><th></th></tr></thead><tbody>
        ${claims
          .map(
            (c) => `<tr><td>${c.id}</td><td>${h(personName(c.request.employeeId))} <span class="muted">${h(c.request.employeeId)}</span></td>
              <td class="num">${h(c.request.amount)} ${c.request.currency}</td><td class="muted desc">${h(c.request.description)}</td>
              <td class="muted">${Math.floor((now - c.createdAt.getTime()) / DAY)} d</td>
              <td>${c.status.state === 'PENDING' ? '<span class="pill">Pending</span>' : c.status.state === 'APPROVED' ? '<span class="pill ok">Approved</span>' : '<span class="pill bad">Rejected</span>'}</td>
              <td class="actions">${
                c.status.state === 'PENDING'
                  ? `<button class="small ok" data-act="hr-approve" data-claim="${c.id}">Approve</button><button class="small" data-act="hr-reject" data-claim="${c.id}">Reject</button>`
                  : ''
              }</td></tr>`,
          )
          .join('')}</tbody></table>`
        : '<p class="muted empty">No claims yet. They appear here the moment a buyer reports a purchase.</p>'
    }
  </section>`;
}

function reportPanel(r: Awaited<ReturnType<SnackApp['monthlyReport']>>): string {
  const row = (o: (typeof r.offices)[number]) => `
    <tr><td><b>${h(o.office)}</b></td><td class="num">${h(format(o.budget))}</td><td class="num">${h(format(o.spent))}</td>
    <td class="num">${o.utilisationPct}%</td><td class="num">${h(format(o.reimbursed))}</td><td class="num">${h(format(o.awaitingReimbursement))}</td>
    <td class="num">${o.refills}</td><td class="num">${o.avgHoursEmpty ?? '-'}</td><td class="items-cell">${h(o.topItems.slice(0, 3).map((t) => t.item).join(', ') || '-')}</td>
    <td class="num">${h(format(o.spentConverted))}</td></tr>`;
  return `
  <section class="card">
    <header class="row-between"><h2>Management report · ${h(r.month)} <small>one report, both offices</small></h2>
      <button class="small" data-act="post-report">Post to #snack-reports</button></header>
    <table class="report"><thead><tr><th>Office</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Used</th><th class="num">Reimbursed</th><th class="num">Awaiting</th><th class="num">Refills</th><th class="num">Hours empty</th><th>Top items</th><th class="num">In ${r.reportingCurrency}</th></tr></thead>
    <tbody>${r.offices.map(row).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${h(format(r.total.budget))}</td><td class="num">${h(format(r.total.spent))}</td><td class="num">${r.total.utilisationPct}%</td>
      <td class="num">${h(format(r.total.reimbursed))}</td><td class="num">${h(format(r.total.awaitingReimbursement))}</td><td colspan="3"></td><td class="num">${h(format(r.total.spent))}</td></tr></tfoot></table>
    <p class="muted fine">Each office is totalled exactly in its own currency; only the totals are converted, at the month's rate (1 INR = ${r.offices[1]?.rate} NOK). “Hours empty” is the average time from “reported empty” to “bought”.</p>
  </section>`;
}

function feedPanel(): string {
  const entries = feed
    .filter((e) => feedFilter === 'all' || e.kind !== 'msg' || (feedFilter === 'channels' ? e.msg.kind === 'channel' : e.msg.kind === 'direct'))
    .slice(-250);
  const people = [...VOLUNTEERS.map((v) => v.employeeId), ...Object.keys(ADMINS)];
  return `
  <section class="card feed">
    <header class="feed-head">
      <h2>Chat</h2>
      <div class="tabs" role="tablist">
        ${(['all', 'channels', 'dms'] as const).map((f) => `<button role="tab" class="${feedFilter === f ? 'on' : ''}" data-act="filter" data-filter="${f}">${{ all: 'Everything', channels: 'Channels', dms: 'Direct messages' }[f]}</button>`).join('')}
      </div>
    </header>
    <div class="feed-list">${entries.length ? entries.map(feedEntry).join('') : `<p class="muted empty">Pick a scenario above, or press “Report box empty”. Every message here is sent by the real bot logic through the simulated chat tool.</p>`}</div>
    <form class="composer" data-act="compose">
      <select data-act="acting-as" aria-label="Acting as">${people.map((p) => `<option value="${p}" ${p === actingAs ? 'selected' : ''}>${h(personName(p))}</option>`).join('')}</select>
      <input name="cmd" data-draft="composer" placeholder="/snack help" value="${h(drafts.get('composer') ?? '')}" autocomplete="off" />
      <button class="primary small" type="submit">Send</button>
    </form>
  </section>`;
}

function feedEntry(e: FeedEntry): string {
  const t = `<time>${h(formatLocal(e.at, 'Europe/Oslo').replace(/^\w+ /, ''))}</time>`;
  if (e.kind === 'note') return `<div class="entry note">${t}<div>${h(e.text)}</div></div>`;
  if (e.kind === 'user') {
    return `<div class="entry user">${t}<div><b>${h(personName(e.who))}</b> <code>${h(e.text)}</code>${
      e.reply ? `<div class="reply">↳ ${h(e.reply.split('\n')[0])}</div>` : ''
    }</div></div>`;
  }
  const m = e.msg;
  const where = m.kind === 'channel' ? `<span class="where ch">${h(m.to)}</span>` : `<span class="where dm">DM → ${h(personName(m.to))}</span>`;
  const buttons = m.actions
    .filter((a) => !a.command.includes('<'))
    .map((a) => `<button class="small" data-act="cmd" data-who="${m.kind === 'direct' ? m.to : ''}" data-cmd="${h(a.command)}">${h(a.label)}</button>`)
    .join('');
  return `<div class="entry bot">${t}<div>${where}<div class="text">${h(m.text)}</div>${buttons ? `<div class="msg-btns">${buttons}</div>` : ''}</div></div>`;
}

// ─── Events ───────────────────────────────────────────────────────────────────

async function run(fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await fn();
  } catch (e) {
    note(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    await render();
  }
}

root.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('button[data-act]');
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'advance':
      return void run(() => advance(Number(d.ms)));
    case 'jump-month':
      return void run(async () => {
        if (app.clock.now() < new Date('2026-11-30T23:15:00Z')) await advanceTo('2026-11-30T23:15:00Z');
        else await advance(DAY);
      });
    case 'reset':
      history.replaceState(null, '', location.pathname);
      return void run(async () => reset());
    case 'scenario':
      history.replaceState(null, '', `#scenario=${d.key}`);
      return void run(() => runScenario(d.key!));
    case 'empty':
      return void run(async () => {
        const office = app.directory.office(d.office!);
        const reporter = VOLUNTEERS.find((v) => presenceKey(v.employeeId, localDate(app.clock.now(), office.timeZone)) === `office:${office.id}`)
          ?? VOLUNTEERS.find((v) => v.homeOfficeId === office.id)!;
        await say(reporter.employeeId, `/snack empty ${office.id}`);
      });
    case 'cmd':
      return void run(async () => {
        await say(d.who || actingAs, d.cmd!);
      });
    case 'bought':
      return void run(async () => {
        const amount = (drafts.get(`amount:${d.refill}`) ?? root.querySelector<HTMLInputElement>(`[data-draft="amount:${d.refill}"]`)?.value ?? '').trim();
        const items = (drafts.get(`items:${d.refill}`) ?? root.querySelector<HTMLInputElement>(`[data-draft="items:${d.refill}"]`)?.value ?? '').trim();
        await say(d.who!, `/snack bought ${d.refill} ${amount} https://receipts/${d.refill}.jpg ${items}`);
      });
    case 'hr-approve':
      return void run(async () => {
        app.hr.approve(d.claim!);
        note(`HR approved ${d.claim}. The bot picks this up on its next poll.`);
        await app.service.tick();
      });
    case 'hr-reject':
      return void run(async () => {
        app.hr.reject(d.claim!, 'receipt is unreadable');
        note(`HR rejected ${d.claim}.`);
        await app.service.tick();
      });
    case 'filter':
      feedFilter = d.filter as typeof feedFilter;
      return void render();
    case 'post-report':
      return void run(async () => {
        await app.sendMonthlyReport(localMonth(app.clock.now(), 'Europe/Oslo'));
      });
  }
});

root.addEventListener('change', (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const d = el.dataset;
  if (d.act === 'hr-auto') {
    hrAutoApprove = (el as HTMLInputElement).checked;
    return;
  }
  if (d.act === 'acting-as') {
    actingAs = el.value;
    return;
  }
  if (d.act === 'presence') {
    const who = d.who!;
    const office = app.directory.office(d.office!);
    const today = localDate(app.clock.now(), office.timeZone);
    void run(async () => {
      if (el.value === 'unknown') {
        app.directory.clearPresence(who, today);
        note(`${personName(who)} is back to their usual pattern today.`);
      } else if (el.value.startsWith('office:')) await say(who, `/snack here ${el.value.slice(7)}`);
      else if (el.value === 'remote') await say(who, '/snack remote');
      else await say(who, `/snack holiday ${today}`);
    });
  }
});

root.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.draft) drafts.set(el.dataset.draft, el.value);
});

root.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = (drafts.get('composer') ?? '').trim();
  if (!text) return;
  drafts.delete('composer');
  void run(async () => {
    await say(actingAs, text.startsWith('/snack') ? text : `/snack ${text}`);
  });
});

async function runScenario(key: string): Promise<void> {
  const s = SCENARIOS[key];
  if (!s) return;
  reset();
  scenarioTitle = s.title;
  note(`Scenario: ${s.title}`);
  await s.run();
}

reset();
const fromHash = /^#scenario=(\w+)$/.exec(location.hash)?.[1];
if (fromHash && SCENARIOS[fromHash]) void run(() => runScenario(fromHash));
else void render();
