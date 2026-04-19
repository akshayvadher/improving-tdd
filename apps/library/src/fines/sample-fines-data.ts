import type { FineDto, FinesConfig } from './fines.types.js';

const DEFAULT_DAILY_RATE_CENTS = 25;
const DEFAULT_SUSPENSION_THRESHOLD_CENTS = 500;

export function sampleFinesConfig(overrides: Partial<FinesConfig> = {}): FinesConfig {
  return {
    dailyRateCents: DEFAULT_DAILY_RATE_CENTS,
    suspensionThresholdCents: DEFAULT_SUSPENSION_THRESHOLD_CENTS,
    ...overrides,
  };
}

export function sampleFine(overrides: Partial<FineDto> = {}): FineDto {
  return {
    fineId: 'fine-placeholder-id',
    memberId: 'member-placeholder-id',
    loanId: 'loan-placeholder-id',
    amountCents: 100,
    assessedAt: new Date('2030-01-15T00:00:00.000Z'),
    paidAt: null,
    ...overrides,
  };
}
