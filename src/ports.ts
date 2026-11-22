import type { ClaimId, EmployeeId } from './domain/model.js';
import type { Currency } from './domain/money.js';
import type { Month } from './domain/time.js';

/**
 * Ports are the boundaries to systems we don't own. The core logic only talks to these interfaces,
 * so the simulated stand-ins in src/fakes can be swapped for real adapters without touching it.
 */

export interface ChatAction {
  readonly label: string;
  /** The command the chat tool sends back when the button is pressed, e.g. "/snack yes R-1". */
  readonly command: string;
}

export interface ChatPort {
  sendDirect(to: EmployeeId, text: string, actions?: readonly ChatAction[]): Promise<void>;
  postToChannel(channel: string, text: string, actions?: readonly ChatAction[]): Promise<void>;
}

/** Exactly the fields the HR system accepts, per the brief. */
export interface ClaimRequest {
  readonly employeeId: EmployeeId;
  /** Amount in major units as a decimal string, e.g. "450.50", to avoid float surprises on the wire. */
  readonly amount: string;
  readonly currency: Currency;
  readonly description: string;
  readonly receiptImage: string;
}

export type ClaimStatus =
  | { readonly state: 'PENDING' }
  | { readonly state: 'APPROVED'; readonly decidedAt: Date }
  | { readonly state: 'REJECTED'; readonly decidedAt: Date; readonly reason: string };

export interface HrPort {
  createClaim(request: ClaimRequest): Promise<ClaimId>;
  /** We assume the HR system has no webhooks, so the scheduler polls this. */
  getClaimStatus(claimId: ClaimId): Promise<ClaimStatus>;
}

export interface Clock {
  now(): Date;
}

export interface ExchangeRates {
  /** Rate to multiply an amount in `from` by to get `to`, for the given month. */
  rate(from: Currency, to: Currency, month: Month): number;
}

export interface IdGenerator {
  next(prefix: string): string;
}
