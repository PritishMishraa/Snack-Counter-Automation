import { DomainError } from './errors.js';

export type Currency = 'NOK' | 'INR' | 'EUR' | 'USD';

/**
 * Money is stored as an integer number of minor units (øre, paise, cents).
 * Floating point is never used for stored amounts, so sums are exact.
 */
export interface Money {
  readonly minor: number;
  readonly currency: Currency;
}

const MINOR_PER_MAJOR = 100;

export function money(major: number, currency: Currency): Money {
  if (!Number.isFinite(major)) throw new DomainError('INVALID_AMOUNT', `Amount must be a finite number, got ${major}`);
  return { minor: Math.round(major * MINOR_PER_MAJOR), currency };
}

export function fromMinor(minor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(minor)) throw new DomainError('INVALID_AMOUNT', `Minor units must be an integer, got ${minor}`);
  return { minor, currency };
}

export function zero(currency: Currency): Money {
  return { minor: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError('CURRENCY_MISMATCH', `Cannot combine ${a.currency} with ${b.currency} without conversion`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function min(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return a.minor <= b.minor ? a : b;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor - b.minor;
}

export function isPositive(m: Money): boolean {
  return m.minor > 0;
}

export function toMajor(m: Money): number {
  return m.minor / MINOR_PER_MAJOR;
}

export function format(m: Money): string {
  const sign = m.minor < 0 ? '-' : '';
  const abs = Math.abs(m.minor);
  const major = Math.floor(abs / MINOR_PER_MAJOR);
  const rest = String(abs % MINOR_PER_MAJOR).padStart(2, '0');
  return `${sign}${major.toLocaleString('en-US')}.${rest} ${m.currency}`;
}

/** "1234.50" — the wire format used for the HR system. */
export function toDecimalString(m: Money): string {
  const sign = m.minor < 0 ? '-' : '';
  const abs = Math.abs(m.minor);
  return `${sign}${Math.floor(abs / MINOR_PER_MAJOR)}.${String(abs % MINOR_PER_MAJOR).padStart(2, '0')}`;
}

/** Converts using a decimal rate, rounding half away from zero to the nearest minor unit. */
export function convert(m: Money, to: Currency, rate: number): Money {
  if (m.currency === to) return m;
  if (!(rate > 0)) throw new DomainError('INVALID_RATE', `Exchange rate ${m.currency}->${to} must be positive`);
  const raw = m.minor * rate;
  const rounded = Math.sign(raw) * Math.round(Math.abs(raw));
  return { minor: rounded, currency: to };
}
