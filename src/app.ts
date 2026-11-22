import { ChatCommands } from './chat/commands.js';
import { OFFICES } from './config.js';
import { DEFAULT_POLICY, type Policy } from './core/policy.js';
import { RefillService } from './core/refill-service.js';
import { buildMonthlyReport, renderReport, type MonthlyReport } from './core/report.js';
import type { Office, Volunteer } from './domain/model.js';
import type { Currency } from './domain/money.js';
import type { Month } from './domain/time.js';
import { FakeChat } from './fakes/fake-chat.js';
import { FakeHr } from './fakes/fake-hr.js';
import { FakeClock, FixedRates, SequentialIds } from './fakes/support.js';
import type { ExchangeRates } from './ports.js';
import { Directory } from './store/directory.js';
import { InMemoryRefillStore } from './store/refill-store.js';

export interface SnackAppOptions {
  readonly start?: Date | string;
  readonly offices?: readonly Office[];
  readonly volunteers?: readonly Volunteer[];
  readonly policy?: Partial<Policy>;
  readonly rates?: ExchangeRates;
  readonly reportingCurrency?: Currency;
  readonly managementChannel?: string;
}

/** Wires the core logic to the simulated chat tool, HR system, clock and in-memory storage. */
export function createSnackApp(options: SnackAppOptions = {}) {
  const clock = new FakeClock(options.start ?? '2026-11-02T08:00:00Z');
  const chat = new FakeChat();
  const hr = new FakeHr(clock);
  const store = new InMemoryRefillStore();
  const directory = new Directory(options.offices ?? OFFICES, options.volunteers ?? []);
  const policy: Policy = { ...DEFAULT_POLICY, ...options.policy };
  const rates = options.rates ?? new FixedRates({ 'INR->NOK': 0.13 });
  const reportingCurrency = options.reportingCurrency ?? 'NOK';
  const managementChannel = options.managementChannel ?? '#snack-reports';

  const service = new RefillService({ store, directory, chat, hr, clock, ids: new SequentialIds(), policy });
  const commands = new ChatCommands(service, directory, clock);

  async function monthlyReport(month: Month): Promise<MonthlyReport> {
    return buildMonthlyReport(month, directory.listOffices(), await store.list(), rates, reportingCurrency);
  }

  async function sendMonthlyReport(month: Month): Promise<MonthlyReport> {
    const report = await monthlyReport(month);
    await chat.postToChannel(managementChannel, renderReport(report));
    return report;
  }

  return { clock, chat, hr, store, directory, policy, service, commands, monthlyReport, sendMonthlyReport };
}

export type SnackApp = ReturnType<typeof createSnackApp>;
