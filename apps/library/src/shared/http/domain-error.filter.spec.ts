import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { FineAlreadyPaidError, FineNotFoundError } from '../../fines/index.js';
import { DomainErrorFilter } from './domain-error.filter.js';

interface CapturedResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function buildHost(response: CapturedResponse): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

function captureResponse(): CapturedResponse {
  const response: CapturedResponse = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

describe('DomainErrorFilter — Fines mappings', () => {
  it('maps FineNotFoundError to 404', () => {
    // given the filter and a captured response
    const filter = new DomainErrorFilter();
    const response = captureResponse();

    // when a FineNotFoundError is caught
    filter.catch(new FineNotFoundError('fine-1'), buildHost(response));

    // then the response status is 404
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        error: 'FineNotFoundError',
        message: 'Fine not found: fine-1',
      }),
    );
  });

  it('maps FineAlreadyPaidError to 409', () => {
    // given the filter and a captured response
    const filter = new DomainErrorFilter();
    const response = captureResponse();

    // when a FineAlreadyPaidError is caught
    filter.catch(new FineAlreadyPaidError('fine-2'), buildHost(response));

    // then the response status is 409
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        error: 'FineAlreadyPaidError',
        message: 'Fine already paid: fine-2',
      }),
    );
  });
});
