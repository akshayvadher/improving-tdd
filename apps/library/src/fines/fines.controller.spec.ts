// This file tests HTTP routing only. The domain behaviour lives in
// `fines.facade.spec.ts` against real factory-wired facades. Here, a trivial
// `fakeFacade` is acceptable because we're testing the controller-to-facade
// seam, not the facade itself — the facade was exhaustively covered in slices
// 2–5 against real collaborators. Spinning the full Lending/Catalog/Membership
// graph just to verify route wiring would be wasteful.

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assessFinesFor,
  findFine,
  listFinesFor,
  payFine,
  processOverdueLoans,
} from '../../test/support/interactions/fines-interactions.js';
import { DomainErrorFilter } from '../shared/http/domain-error.filter.js';
import { FinesController } from './fines.controller.js';
import { FinesFacade } from './fines.facade.js';
import { FineAlreadyPaidError, FineNotFoundError, type FineDto } from './fines.types.js';
import { sampleFine } from './sample-fines-data.js';

/**
 * NOTE: MAY BE WE CAN USE MOCKS instead of hand rolling things!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
interface FakeFacade {
  assessFinesFor: (...args: unknown[]) => Promise<FineDto[]>;
  processOverdueLoans: (...args: unknown[]) => Promise<void>;
  listFinesFor: (...args: unknown[]) => Promise<FineDto[]>;
  findFine: (...args: unknown[]) => Promise<FineDto>;
  payFine: (...args: unknown[]) => Promise<FineDto>;
}

interface Call {
  method: keyof FakeFacade;
  args: unknown[];
}

interface Harness {
  app: INestApplication;
  calls: Call[];
  facade: FakeFacade;
}

function buildFakeFacade(calls: Call[], responders: Partial<FakeFacade>): FakeFacade {
  const record = <T>(
    method: keyof FakeFacade,
    fallback: () => Promise<T>,
  ): ((...args: unknown[]) => Promise<T>) => {
    return async (...args: unknown[]) => {
      calls.push({ method, args });
      const override = responders[method] as ((...a: unknown[]) => Promise<T>) | undefined;
      if (override) {
        return override(...args);
      }
      return fallback();
    };
  };

  return {
    assessFinesFor: record('assessFinesFor', async () => []),
    processOverdueLoans: record('processOverdueLoans', async () => undefined),
    listFinesFor: record('listFinesFor', async () => []),
    findFine: record('findFine', async () => sampleFine()),
    payFine: record('payFine', async () => sampleFine()),
  };
}

async function buildHarness(responders: Partial<FakeFacade> = {}): Promise<Harness> {
  const calls: Call[] = [];
  const facade = buildFakeFacade(calls, responders);

  const moduleRef = await Test.createTestingModule({
    controllers: [FinesController],
    providers: [{ provide: FinesFacade, useValue: facade }],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();

  return { app, calls, facade };
}

function firstCall(harness: Harness): Call {
  const call = harness.calls[0];
  if (!call) {
    throw new Error('Expected at least one facade call, got none');
  }
  return call;
}

describe('FinesController — HTTP routing', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness?.app) {
      await harness.app.close();
    }
  });

  describe('POST /members/:memberId/fines/assessments (AC-6.1)', () => {
    it('routes to facade.assessFinesFor with the memberId and a server-side Date', async () => {
      // given a fake facade that returns a single assessed fine
      const assessed = sampleFine({
        fineId: 'fine-1',
        memberId: 'mem-42',
        loanId: 'loan-7',
        amountCents: 150,
      });
      harness = await buildHarness({ assessFinesFor: async () => [assessed] });

      // when the assessments endpoint is hit for the member
      const response = await assessFinesFor(harness.app, 'mem-42');

      // then the facade received the memberId plus a freshly-constructed Date
      expect(harness.calls).toHaveLength(1);
      expect(firstCall(harness).method).toBe('assessFinesFor');
      expect(firstCall(harness).args[0]).toBe('mem-42');
      expect(firstCall(harness).args[1]).toBeInstanceOf(Date);

      // and the response surfaces the fines the facade returned with 200 OK
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { ...assessed, assessedAt: assessed.assessedAt.toISOString() },
      ]);
    });
  });

  describe('POST /fines/batch/process (AC-6.2)', () => {
    it('routes to facade.processOverdueLoans with a server-side Date and returns 204 with empty body', async () => {
      // given a fake facade whose batch is a no-op
      harness = await buildHarness();

      // when the batch endpoint is hit
      const response = await processOverdueLoans(harness.app);

      // then the facade received a Date
      expect(harness.calls).toHaveLength(1);
      expect(firstCall(harness).method).toBe('processOverdueLoans');
      expect(firstCall(harness).args[0]).toBeInstanceOf(Date);

      // and the response is 204 with no body
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });
  });

  describe('GET /members/:memberId/fines (AC-6.3)', () => {
    it('routes to facade.listFinesFor with the memberId and returns its fines', async () => {
      // given a fake facade that returns a list of fines for the member
      const fines = [
        sampleFine({ fineId: 'fine-1', memberId: 'mem-99' }),
        sampleFine({ fineId: 'fine-2', memberId: 'mem-99' }),
      ];
      harness = await buildHarness({ listFinesFor: async () => fines });

      // when the list endpoint is hit
      const response = await listFinesFor(harness.app, 'mem-99');

      // then the facade received the memberId
      expect(harness.calls).toHaveLength(1);
      expect(firstCall(harness).method).toBe('listFinesFor');
      expect(firstCall(harness).args).toEqual(['mem-99']);

      // and the response body matches the returned fines
      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        fines.map((fine) => ({
          ...fine,
          assessedAt: fine.assessedAt.toISOString(),
        })),
      );
    });
  });

  describe('GET /fines/:fineId (AC-6.4)', () => {
    it('returns the fine from facade.findFine on the happy path', async () => {
      // given a fake facade that returns a stored fine for the id
      const fine = sampleFine({ fineId: 'fine-42' });
      harness = await buildHarness({ findFine: async () => fine });

      // when the find endpoint is hit with that id
      const response = await findFine(harness.app, 'fine-42');

      // then the facade was called with the id
      expect(firstCall(harness).method).toBe('findFine');
      expect(firstCall(harness).args).toEqual(['fine-42']);

      // and the body matches the returned fine
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ...fine,
        assessedAt: fine.assessedAt.toISOString(),
      });
    });

    it('surfaces FineNotFoundError as a 404 through the domain-error filter', async () => {
      // given a fake facade that throws FineNotFoundError for an unknown id
      harness = await buildHarness({
        findFine: async () => {
          throw new FineNotFoundError('fine-missing');
        },
      });

      // when the find endpoint is hit with the unknown id
      const response = await findFine(harness.app, 'fine-missing');

      // then the filter maps the error to 404 with the typed body
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        statusCode: 404,
        error: 'FineNotFoundError',
        message: 'Fine not found: fine-missing',
      });
    });
  });

  describe('PATCH /fines/:fineId/paid (AC-6.5)', () => {
    it('returns the updated fine from facade.payFine on the happy path', async () => {
      // given a fake facade that returns a paid-stamped fine
      const paid = sampleFine({
        fineId: 'fine-7',
        paidAt: new Date('2030-02-01T00:00:00.000Z'),
      });
      harness = await buildHarness({ payFine: async () => paid });

      // when the pay endpoint is hit
      const response = await payFine(harness.app, 'fine-7');

      // then the facade was called with the fineId
      expect(firstCall(harness).method).toBe('payFine');
      expect(firstCall(harness).args).toEqual(['fine-7']);

      // and the response body matches the updated fine
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ...paid,
        assessedAt: paid.assessedAt.toISOString(),
        paidAt: paid.paidAt?.toISOString(),
      });
    });

    it('surfaces FineAlreadyPaidError as a 409 through the domain-error filter', async () => {
      // given a fake facade that throws FineAlreadyPaidError on the second call
      let callCount = 0;
      harness = await buildHarness({
        payFine: async () => {
          callCount += 1;
          if (callCount === 1) {
            return sampleFine({
              fineId: 'fine-9',
              paidAt: new Date('2030-02-01T00:00:00.000Z'),
            });
          }
          throw new FineAlreadyPaidError('fine-9');
        },
      });

      // when the pay endpoint is hit twice
      const first = await payFine(harness.app, 'fine-9');
      const second = await payFine(harness.app, 'fine-9');

      // then the first call succeeds
      expect(first.status).toBe(200);

      // and the second call maps to 409 with the typed body
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        statusCode: 409,
        error: 'FineAlreadyPaidError',
        message: 'Fine already paid: fine-9',
      });
    });
  });

  // AC-6.6: the `fines-interactions.ts` helpers are exercised by every test in
  // this file (assessFinesFor / processOverdueLoans / listFinesFor / findFine /
  // payFine). Each successful assertion above proves the helper targets the
  // right endpoint and returns a response whose body matches the typed DTO.
});
