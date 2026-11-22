export type ErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_RATE'
  | 'CURRENCY_MISMATCH'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'NOT_ALLOWED'
  | 'ALREADY_TAKEN'
  | 'CONCURRENT_UPDATE'
  | 'BUDGET_EXCEEDED'
  | 'UNKNOWN_COMMAND';

/** An expected, user-facing failure (as opposed to a bug). The chat layer turns these into replies. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
