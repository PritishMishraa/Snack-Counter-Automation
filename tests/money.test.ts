import { describe, expect, it } from 'vitest';
import { add, convert, format, money, sum, toDecimalString } from '../src/domain/money.js';
import { DomainError } from '../src/domain/errors.js';

describe('money', () => {
  it('adds without floating point drift', () => {
    const total = sum([money(0.1, 'NOK'), money(0.2, 'NOK'), money(0.7, 'NOK')], 'NOK');
    expect(total).toEqual(money(1, 'NOK'));
    expect(toDecimalString(total)).toBe('1.00');
  });

  it('refuses to add different currencies', () => {
    expect(() => add(money(1, 'NOK'), money(1, 'INR'))).toThrow(DomainError);
  });

  it('converts and rounds to the nearest minor unit', () => {
    expect(convert(money(100, 'INR'), 'NOK', 0.12345)).toEqual(money(12.35, 'NOK'));
    expect(convert(money(1, 'NOK'), 'NOK', 99)).toEqual(money(1, 'NOK'));
    expect(() => convert(money(1, 'INR'), 'NOK', 0)).toThrow(DomainError);
  });

  it('formats for humans and for the HR system', () => {
    expect(format(money(15000, 'INR'))).toBe('15,000.00 INR');
    expect(toDecimalString(money(1234.5, 'NOK'))).toBe('1234.50');
    expect(toDecimalString(money(0.05, 'NOK'))).toBe('0.05');
  });
});
