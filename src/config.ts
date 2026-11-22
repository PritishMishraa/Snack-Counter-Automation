import type { Office } from './domain/model.js';
import { money } from './domain/money.js';

/**
 * Figures from the brief. maxPurchase/minPurchase are the "typical purchase" range: a receipt inside
 * the range is pre-approved, anything bigger needs an admin, and the refill waits if less than the
 * minimum is left in the month (a 100 NOK top-up isn't worth a trip and a claim).
 */
export const OFFICES: readonly Office[] = [
  {
    id: 'OSL',
    name: 'Oslo',
    currency: 'NOK',
    timeZone: 'Europe/Oslo',
    monthlyBudget: money(6_000, 'NOK'),
    maxPurchase: money(1_200, 'NOK'),
    minPurchase: money(300, 'NOK'),
    channel: '#snacks-oslo',
    admins: ['osl-admin'],
  },
  {
    id: 'BLR',
    name: 'Bengaluru',
    currency: 'INR',
    timeZone: 'Asia/Kolkata',
    monthlyBudget: money(15_000, 'INR'),
    maxPurchase: money(3_000, 'INR'),
    minPurchase: money(500, 'INR'),
    channel: '#snacks-bengaluru',
    admins: ['blr-admin'],
  },
];
