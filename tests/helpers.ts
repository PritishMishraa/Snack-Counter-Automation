import { createSnackApp, type SnackAppOptions } from '../src/app.js';
import type { EmployeeId, Refill, Volunteer } from '../src/domain/model.js';
import { money, type Money } from '../src/domain/money.js';
import { DomainError, type ErrorCode } from '../src/domain/errors.js';

export const VOLUNTEERS: Volunteer[] = [
  { employeeId: 'osl-1', name: 'Ada', homeOfficeId: 'OSL', active: true },
  { employeeId: 'osl-2', name: 'Bjørn', homeOfficeId: 'OSL', active: true },
  { employeeId: 'osl-3', name: 'Camilla', homeOfficeId: 'OSL', active: true },
  { employeeId: 'osl-4', name: 'Dag', homeOfficeId: 'OSL', active: true },
  { employeeId: 'blr-1', name: 'Anil', homeOfficeId: 'BLR', active: true },
  { employeeId: 'blr-2', name: 'Bhavna', homeOfficeId: 'BLR', active: true },
  { employeeId: 'blr-3', name: 'Chetan', homeOfficeId: 'BLR', active: true },
];

/** Monday 2 Nov 2026, 09:00 in Oslo / 13:30 in Bengaluru. */
export const START = '2026-11-02T08:00:00Z';

export function makeApp(options: SnackAppOptions = {}) {
  return createSnackApp({ start: START, volunteers: VOLUNTEERS, ...options });
}

export type App = ReturnType<typeof makeApp>;

export const nok = (n: number): Money => money(n, 'NOK');
export const inr = (n: number): Money => money(n, 'INR');

/** Drives one refill from "empty" to "claim submitted" with the given buyer. */
export async function completeRefill(
  app: App,
  officeId: string,
  buyer: EmployeeId,
  amount: Money,
  items: string[] = [],
): Promise<Refill> {
  const { refill } = await app.service.reportEmpty(officeId, buyer);
  await app.service.commit(refill.id, buyer);
  return app.service.recordPurchase(refill.id, buyer, { amount, receiptImage: `receipt-${refill.id}.jpg`, items });
}

export async function expectDomainError(p: Promise<unknown>, code: ErrorCode): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError && e.code === code) return e;
    throw new Error(`Expected DomainError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`Expected DomainError ${code}, but the call succeeded`);
}
