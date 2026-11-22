/**
 * Scenario player for the snack bot. Each scenario runs the real core logic from src/ in the browser
 * against the simulated chat tool and HR system, and shows the resulting chat transcript.
 * The sample management report comes from simulating a whole month with the same code.
 */
import { createSnackApp, type SnackApp } from '../src/app.js';
import type { MonthlyReport, OfficeReport } from '../src/core/report.js';
import type { EmployeeId, Refill, Volunteer } from '../src/domain/model.js';
import { format, type Money } from '../src/domain/money.js';
import { DAY, HOUR, MINUTE, localDate, type Weekday } from '../src/domain/time.js';
import type { SentMessage } from '../src/fakes/fake-chat.js';

const START = '2026-11-02T08:00:00Z'; // Monday 09:00 in Oslo, 13:30 in Bengaluru
const OSLO = 'Europe/Oslo';

const VOLUNTEERS: Volunteer[] = [
  ...['Ada', 'Bjørn', 'Camilla', 'Dag', 'Eirin', 'Fredrik'].map((name, i) => ({ employeeId: `osl-${i + 1}`, name, homeOfficeId: 'OSL', active: true })),
  ...['Anil', 'Bhavna', 'Chetan', 'Divya', 'Esha', 'Farhan', 'Gauri'].map((name, i) => ({ employeeId: `blr-${i + 1}`, name, homeOfficeId: 'BLR', active: true })),
];
const ADMINS: Record<string, string> = { 'osl-admin': 'Oslo office manager', 'blr-admin': 'Bengaluru office manager' };

/** Hybrid patterns (usual office weekdays, 0 = Sunday). People without one are "unknown". */
const PATTERNS: Array<[EmployeeId, Weekday[]]> = [
  ['osl-1', [1, 2, 4]], ['osl-2', [1, 3]], ['osl-3', [2, 3, 4]], ['osl-5', [1, 2, 3, 4, 5]], ['osl-6', [3, 5]],
  ['blr-1', [1, 2, 3, 4, 5]], ['blr-2', [1, 3, 5]], ['blr-3', [2, 4]], ['blr-5', [1, 2, 3, 4]], ['blr-7', [1, 2]],
];

type Entry =
  | { kind: 'bot'; at: Date; msg: SentMessage }
  | { kind: 'user'; at: Date; who: EmployeeId; text: string; reply?: string }
  | { kind: 'note'; at: Date; text: string };

// ─── A fresh simulated world ──────────────────────────────────────────────────

class Sim {
  readonly app: SnackApp = createSnackApp({ start: START, volunteers: VOLUNTEERS });
  readonly entries: Entry[] = [];
  /** How long the simulated HR takes to approve a given claim (the brief says 1–10 days). */
  hrApprovalMs: (claimId: string) => number = () => 3 * DAY;

  private muted = false;

  constructor() {
    this.app.chat.onMessage((msg) => {
      if (!this.muted) this.entries.push({ kind: 'bot', at: this.app.clock.now(), msg });
    });
    for (const [id, days] of PATTERNS) this.app.directory.setOfficeDays(id, days);
    this.app.directory.setPresenceRange('osl-5', '2026-11-02', '2026-11-06', { kind: 'holiday' });
  }

  /** Runs setup steps without adding them to the transcript. */
  async quietly(fn: () => Promise<void>): Promise<void> {
    this.muted = true;
    try {
      await fn();
    } finally {
      this.muted = false;
    }
  }

  async say(who: EmployeeId, text: string): Promise<string> {
    const entry: Entry = { kind: 'user', at: this.app.clock.now(), who, text };
    if (!this.muted) this.entries.push(entry);
    entry.reply = await this.app.commands.handle(who, text);
    return entry.reply;
  }

  note(text: string): void {
    this.entries.push({ kind: 'note', at: this.app.clock.now(), text });
  }

  /** Moves time forward in 15-minute steps, running the scheduler each step like a cron job. */
  async advance(ms: number): Promise<void> {
    const end = this.app.clock.now().getTime() + ms;
    while (this.app.clock.now().getTime() < end) {
      this.app.clock.advance(Math.min(15 * MINUTE, end - this.app.clock.now().getTime()));
      const now = this.app.clock.now().getTime();
      for (const c of this.app.hr.claims.values()) {
        if (c.status.state === 'PENDING' && now - c.createdAt.getTime() >= this.hrApprovalMs(c.id)) this.app.hr.approve(c.id);
      }
      await this.app.service.tick();
    }
  }

  async advanceTo(iso: string): Promise<void> {
    await this.advance(new Date(iso).getTime() - this.app.clock.now().getTime());
  }

  async active(officeId: string): Promise<Refill | undefined> {
    return this.app.store.findActive(officeId);
  }
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

interface Scenario {
  readonly title: string;
  readonly summary: string;
  readonly proves: string;
  readonly run: (s: Sim) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  race: {
    title: 'Two people tap “Yes” at once',
    summary: 'Ada and Bjørn both offer to buy within the same millisecond.',
    proves: 'Only one buyer per refill',
    async run(s) {
      s.note('Dag finds the Oslo box empty. Ada and Bjørn both tap “Yes” within milliseconds.');
      await s.say('osl-4', '/snack empty');
      const r = (await s.active('OSL'))!;
      await Promise.all([s.say('osl-1', `/snack yes ${r.id}`), s.say('osl-2', `/snack yes ${r.id}`)]);
      s.note('Exactly one commit wins (a compare-and-set on the refill’s version). The other person is told not to buy.');
    },
  },
  silence: {
    title: 'Nobody answers',
    summary: 'The box is reported empty and every DM goes unanswered.',
    proves: 'A stalled refill escalates',
    async run(s) {
      s.note('The box is reported empty, and nobody answers their DM.');
      await s.say('osl-4', '/snack empty');
      for (let i = 0; i < 3; i++) await s.advance(2 * HOUR);
      s.note('After three unanswered 2-hour offers, the refill is opened to the whole #snacks-oslo channel.');
      await s.advanceTo('2026-11-03T07:15:00Z');
      s.note('Still nobody. The bot stays quiet overnight; at 08:00 the next morning it posts again and alerts the office manager.');
    },
  },
  lapse: {
    title: 'Buyer commits, then forgets',
    summary: 'Someone says “Yes”, then never reports a purchase.',
    proves: 'Unfinished refills are handed on',
    async run(s) {
      await s.say('osl-4', '/snack empty');
      const r = (await s.active('OSL'))!;
      await s.say(r.offer!.to!, `/snack yes ${r.id}`);
      s.note('The buyer has 24 hours. The reminder is due 6 hours before the deadline, at 03:00, so it waits for office hours…');
      await s.advance(23 * HOUR + 15 * MINUTE);
      s.note('…and goes out at 08:00 instead. The deadline at 09:00 passes without a purchase.');
      await s.advance(45 * MINUTE);
      s.note('The refill is handed to the next person and the budget reservation is released. The first buyer can still report a late purchase until someone else commits.');
    },
  },
  visitor: {
    title: 'Visiting the other office',
    summary: 'Anil from Bengaluru works from Oslo for two weeks.',
    proves: 'People are asked where they are',
    async run(s) {
      s.note('Anil will be in Oslo for two weeks. One command covers the whole trip, with no daily check-ins.');
      await s.say('blr-1', '/snack visiting oslo 2026-11-02 2026-11-13');
      await s.say('osl-4', '/snack empty');
      await s.say('blr-3', '/snack empty');
      s.note('Anil is asked in Oslo, where he is, and skipped in Bengaluru even though he is usually in on weekdays. A purchase in Oslo is charged to Oslo’s NOK budget; HR pays him in INR.');
    },
  },
  budget: {
    title: 'The budget runs out',
    summary: 'Five big refills use up most of Oslo’s 6,000 NOK.',
    proves: 'Spending stays within budget',
    async run(s) {
      await s.quietly(async () => {
        for (const b of ['osl-1', 'osl-2', 'osl-3', 'osl-4', 'osl-6']) {
          await s.say('osl-4', '/snack empty');
          const r = (await s.active('OSL'))!;
          await s.say(b, `/snack yes ${r.id}`);
          await s.say(b, `/snack bought ${r.id} 1150 https://receipts/${r.id}.jpg chips, fruit`);
          await s.advance(HOUR);
        }
      });
      s.note('Earlier today, five refills of 1,150 NOK used 5,750 of Oslo’s 6,000 NOK monthly budget. Now the box is empty again.');
      await s.say('osl-4', '/snack status');
      await s.say('osl-4', '/snack empty');
      s.note('Only 250 NOK is left, below a sensible minimum purchase of 300 NOK, so the refill is put on hold and the manager is told. Fast-forward to December…');
      await s.quietly(() => s.advanceTo('2026-12-01T06:45:00Z'));
      await s.advanceTo('2026-12-01T07:15:00Z');
      s.note('The December budget starts at midnight in Oslo. The bot waits for office hours, then resumes the refill by itself.');
    },
  },
  overLimit: {
    title: 'A receipt above the limit',
    summary: 'A buyer spends 1,480 NOK against a 1,200 NOK limit.',
    proves: 'Big receipts need a manager',
    async run(s) {
      await s.say('osl-4', '/snack empty');
      const r = (await s.active('OSL'))!;
      const buyer = r.offer!.to!;
      await s.say(buyer, `/snack yes ${r.id}`);
      await s.say(buyer, `/snack bought ${r.id} 1480 https://receipts/${r.id}.jpg cake, coffee`);
      s.note('1,480 NOK is above the pre-approved limit, so the HR claim waits for the office manager.');
      await s.advance(30 * MINUTE);
      await s.say('osl-admin', `/snack approve ${r.id}`);
      s.note('Approved: the claim goes to HR, and the 1,480 NOK counts against this month’s budget.');
    },
  },
  month: {
    title: 'A whole month, both offices',
    summary: 'Every working day of November with random empties, declines and timeouts.',
    proves: 'One report in two currencies',
    async run(s) {
      s.note('Simulating November at both offices: boxes empty at random, some people decline or don’t answer, and HR takes 1 to 10 days to approve each claim.');
      await simulateMonth(s);
      s.note('Done. The management report below is the result of this month.');
    },
  },
};

/** Deterministic pseudo-random numbers, so the month is the same every time. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function simulateMonth(s: Sim): Promise<void> {
  const rand = rng(7);
  // Each claim gets its own fixed turnaround between 1 and 10 days.
  s.hrApprovalMs = (id) => (1 + ((Number(id.replace(/\D/g, '')) * 37) % 10)) * DAY;
  const items: Record<string, string[]> = {
    OSL: ['chips', 'fruit', 'kvikk lunsj', 'nuts', 'cola', 'knekkebrød'],
    BLR: ['samosa', 'biscuits', 'banana chips', 'chikki', 'juice', 'fruit'],
  };
  for (let day = 2; day <= 30; day++) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    await s.advanceTo(`${date}T07:30:00Z`);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const office of s.app.directory.listOffices()) {
      if (rand() > 0.34 || (await s.active(office.id))) continue;
      const locals = VOLUNTEERS.filter((v) => v.homeOfficeId === office.id);
      const pick = () => locals[Math.floor(rand() * locals.length)]!.employeeId;
      await s.say(pick(), `/snack empty ${office.id}`);
      for (let attempt = 0; attempt < 6; attempt++) {
        const r = await s.active(office.id);
        if (!r || r.status !== 'AWAITING_VOLUNTEER') break;
        const who = r.offer?.to ?? pick();
        const roll = rand();
        if (roll < 0.65) {
          await s.say(who, `/snack yes ${r.id}`);
          break;
        }
        if (roll < 0.85) await s.say(who, `/snack no ${r.id}`);
        else await s.advance(2 * HOUR);
      }
      const r = await s.active(office.id);
      if (r?.status !== 'COMMITTED') continue;
      const [lo, hi] = office.currency === 'NOK' ? [350, 1150] : [600, 2900];
      // Buyers stay within the limit the bot gave them (the over-limit path has its own scenario).
      const amount = Math.min(Math.round((lo + rand() * (hi - lo)) / 10) * 10, Math.floor(r.commitment!.spendLimit.minor / 100));
      const bought = items[office.id]!.filter(() => rand() < 0.4).join(', ') || items[office.id]![0]!;
      await s.advance(HOUR);
      await s.say(r.commitment!.buyer, `/snack bought ${r.id} ${amount} https://receipts/${r.id}.jpg ${bought}`);
    }
  }
  await s.advanceTo('2026-11-30T17:00:00Z');
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function h(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function personName(id: EmployeeId): string {
  return VOLUNTEERS.find((v) => v.employeeId === id)?.name ?? ADMINS[id] ?? id;
}

function avatar(id: EmployeeId | 'bot'): string {
  if (id === 'bot') return `<span class="avatar bot" aria-hidden="true">S</span>`;
  const cls = id.startsWith('osl') ? 'osl' : id.startsWith('blr') ? 'blr' : 'admin';
  return `<span class="avatar ${cls}" aria-hidden="true">${h(personName(id).charAt(0))}</span>`;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: OSLO, hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: OSLO, weekday: 'long', day: 'numeric', month: 'long' });

/** Turns bare refill/claim ids and amounts into subtle highlights. */
function richText(text: string): string {
  return h(text)
    .replace(/\b(R-(?:OSL|BLR)-\d+|HR-\d+)\b/g, '<span class="ref">$1</span>')
    .replace(/(\d[\d,]*\.\d{2} (?:NOK|INR))/g, '<b class="amt">$1</b>');
}

function transcript(entries: readonly Entry[]): string {
  let lastDay = '';
  let i = 0;
  const rows: string[] = [];
  for (const e of entries) {
    const day = localDate(e.at, OSLO);
    if (day !== lastDay) {
      rows.push(`<div class="day" style="--i:${i++}"><span>${h(dayFmt.format(e.at))}</span></div>`);
      lastDay = day;
    }
    rows.push(entry(e, i++));
  }
  return rows.join('');
}

function entry(e: Entry, i: number): string {
  const time = `<time>${h(timeFmt.format(e.at))}</time>`;
  const style = `style="--i:${Math.min(i, 60)}"`;
  if (e.kind === 'note') {
    return `<div class="note" ${style}><span class="note-mark" aria-hidden="true"></span><p>${h(e.text)}</p></div>`;
  }
  if (e.kind === 'user') {
    return `<div class="msg" ${style}>${avatar(e.who)}<div class="body">
      <div class="meta"><b>${h(personName(e.who))}</b>${time}</div>
      <code class="cmd">${h(e.text)}</code>
      ${e.reply ? `<div class="reply">${richText(e.reply.split('\n')[0]!)}</div>` : ''}
    </div></div>`;
  }
  const m = e.msg;
  const where =
    m.kind === 'channel'
      ? `<span class="where channel">${h(m.to)}</span>`
      : `<span class="where dm">DM to ${h(personName(m.to))}</span>`;
  const buttons = m.actions.filter((a) => !a.command.includes('<'));
  return `<div class="msg bot ${m.kind}" ${style}>${avatar('bot')}<div class="body">
    <div class="meta"><b>Snack bot</b>${where}${time}</div>
    <div class="text">${richText(m.text)}</div>
    ${buttons.length ? `<div class="buttons">${buttons.map((a) => `<span class="fake-btn">${h(a.label)}</span>`).join('')}</div>` : ''}
  </div></div>`;
}

// ─── Month summary (for the long scenario) ────────────────────────────────────

async function monthSummary(s: Sim): Promise<string> {
  const refills = await s.app.store.list();
  const events = refills.flatMap((r) => r.history.map((e) => e.type));
  const count = (t: string) => events.filter((e) => e === t).length;
  const tiles: Array<[string, number]> = [
    ['Refills bought', refills.filter((r) => r.purchase).length],
    ['Direct offers sent', count('OFFERED')],
    ['Declined', count('DECLINED')],
    ['Unanswered, passed on', count('OFFER_EXPIRED')],
    ['HR claims filed', s.app.hr.claims.size],
    ['Chat messages', s.entries.filter((e) => e.kind === 'bot').length],
  ];
  const tail = s.entries.filter((e) => e.kind !== 'note').slice(-8);
  return `
    <div class="tiles">${tiles.map(([label, n]) => `<div class="tile"><b>${n}</b><span>${h(label)}</span></div>`).join('')}</div>
    <p class="tail-label">The last few messages of the month</p>
    ${transcript(tail)}
    <a class="to-report" href="#report">See the management report ↓</a>`;
}

// ─── Management report ────────────────────────────────────────────────────────

function pct(part: Money, whole: Money): number {
  return whole.minor ? Math.min(100, (part.minor / whole.minor) * 100) : 0;
}

function officeBlock(o: OfficeReport, reporting: string): string {
  const reimbursedPct = pct(o.reimbursed, o.budget);
  const awaitingPct = pct(o.awaitingReimbursement, o.budget);
  const buyers = Object.entries(o.refillsByVolunteer).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `
  <div class="office">
    <div class="office-top">
      <div><h3>${h(o.office)}</h3><span class="muted">${h(o.currency)} budget</span></div>
      <div class="office-figure"><b>${h(format(o.spent))}</b><span>of ${h(format(o.budget))} · ${o.utilisationPct}%</span></div>
    </div>
    <div class="bar" role="img" aria-label="${o.utilisationPct}% of budget used">
      <span class="reimbursed" style="width:${reimbursedPct}%"></span><span class="awaiting" style="width:${awaitingPct}%"></span>
    </div>
    <dl class="facts">
      <div><dt>Reimbursed</dt><dd>${h(format(o.reimbursed))}</dd></div>
      <div><dt>Awaiting HR</dt><dd>${h(format(o.awaitingReimbursement))}</dd></div>
      <div><dt>Refills</dt><dd>${o.refills}</dd></div>
      <div><dt>Box empty, avg</dt><dd>${o.avgHoursEmpty ?? '-'} h</dd></div>
      ${o.currency !== reporting ? `<div><dt>In ${h(reporting)}</dt><dd>${h(format(o.spentConverted))}</dd></div>` : ''}
    </dl>
    <div class="lists">
      <div><h4>Most bought</h4><ol class="items">${o.topItems.slice(0, 4).map((t) => `<li>${h(t.item)} <span>${t.refills}×</span></li>`).join('')}</ol></div>
      <div><h4>Refills per volunteer</h4><ul class="buyers">${buyers.map(([id, n]) => `<li>${avatar(id)}${h(personName(id))} <span>${n}</span></li>`).join('')}</ul></div>
    </div>
  </div>`;
}

function reportCard(r: MonthlyReport): string {
  const monthName = new Date(`${r.month}-15T12:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const refills = r.offices.reduce((n, o) => n + o.refills, 0);
  return `
  <header class="report-head">
    <div>
      <span class="eyebrow">Posted to #snack-reports on 1 December</span>
      <h2>Snack spending, ${h(monthName)}</h2>
    </div>
    <span class="sample">Sample data</span>
  </header>
  <div class="kpis">
    <div class="kpi main"><span>Total spent, both offices</span><b>${h(format(r.total.spent))}</b><em>${r.total.utilisationPct}% of ${h(format(r.total.budget))}</em></div>
    <div class="kpi"><span>Reimbursed</span><b>${h(format(r.total.reimbursed))}</b></div>
    <div class="kpi"><span>Awaiting HR</span><b>${h(format(r.total.awaitingReimbursement))}</b></div>
    <div class="kpi"><span>Refills</span><b>${refills}</b></div>
  </div>
  <div class="offices">${r.offices.map((o) => officeBlock(o, r.reportingCurrency)).join('')}</div>
  <p class="footnote">Each office is totalled exactly in its own currency; only the totals are converted, at the month’s rate
    (1 INR = ${r.offices.find((o) => o.currency === 'INR')?.rate ?? '-'} NOK). “Box empty” is the average time from “reported empty” to “bought”.
    Generated by simulating November with the same code as the scenarios above.</p>`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const list = document.getElementById('scenario-list')!;
const stage = document.getElementById('stage')!;
const report = document.getElementById('report')!;
let current = '';
let runId = 0;

function renderList(): void {
  list.innerHTML = Object.entries(SCENARIOS)
    .map(
      ([key, s], i) => `
      <li><button class="scenario ${key === current ? 'on' : ''}" data-key="${key}" aria-pressed="${key === current}">
        <span class="num">${i + 1}</span>
        <span class="scenario-text"><b>${h(s.title)}</b><span>${h(s.summary)}</span><em>${h(s.proves)}</em></span>
      </button></li>`,
    )
    .join('');
}

async function play(key: string): Promise<void> {
  const scenario = SCENARIOS[key];
  if (!scenario) return;
  current = key;
  const id = ++runId;
  renderList();
  history.replaceState(null, '', `#scenario=${key}`);
  stage.innerHTML = `<div class="stage-head"><div><span class="eyebrow">Scenario ${Object.keys(SCENARIOS).indexOf(key) + 1} of 7</span><h2>${h(scenario.title)}</h2></div></div><div class="loading">Running…</div>`;

  const sim = new Sim();
  await scenario.run(sim);
  if (id !== runId) return;

  const body = key === 'month' ? await monthSummary(sim) : transcript(sim.entries);
  stage.innerHTML = `
    <div class="stage-head">
      <div><span class="eyebrow">Scenario ${Object.keys(SCENARIOS).indexOf(key) + 1} of 7 · times in Oslo</span><h2>${h(scenario.title)}</h2></div>
      <button class="replay" data-replay="${key}">Replay</button>
    </div>
    <div class="proves">Proves: <b>${h(scenario.proves)}</b></div>
    <div class="chat">${body}</div>`;
}

list.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
  if (btn) void play(btn.dataset.key!);
});
stage.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-replay]');
  if (btn) void play(btn.dataset.replay!);
});

async function buildReport(): Promise<void> {
  const sim = new Sim();
  await simulateMonth(sim);
  report.innerHTML = reportCard(await sim.app.monthlyReport('2026-11'));
}

const fromHash = /^#scenario=(\w+)$/.exec(location.hash)?.[1];
void play(fromHash && SCENARIOS[fromHash] ? fromHash : 'race');
void buildReport();
