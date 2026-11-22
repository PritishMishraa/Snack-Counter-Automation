import type { Currency } from '../domain/money.js';
import type { Month } from '../domain/time.js';
import type { Clock, ExchangeRates, IdGenerator } from '../ports.js';

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(instant: Date | string): void {
    this.current = new Date(instant);
  }
}

/**
 * Fixed rates per month. Finance would normally supply the official monthly rate; using one rate per
 * month (not per purchase) keeps the management report reproducible.
 */
export class FixedRates implements ExchangeRates {
  constructor(
    private readonly table: Readonly<Record<string, number>>,
    private readonly byMonth: Readonly<Record<Month, Readonly<Record<string, number>>>> = {},
  ) {}

  rate(from: Currency, to: Currency, month: Month): number {
    if (from === to) return 1;
    const k = `${from}->${to}`;
    const r = this.byMonth[month]?.[k] ?? this.table[k];
    if (r !== undefined) return r;
    const inverse = this.byMonth[month]?.[`${to}->${from}`] ?? this.table[`${to}->${from}`];
    if (inverse !== undefined) return 1 / inverse;
    throw new Error(`No exchange rate ${k} for ${month}`);
  }
}

export class SequentialIds implements IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}
