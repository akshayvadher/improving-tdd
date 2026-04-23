import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { InvalidBookError, InvalidCopyError } from '../../catalog/index.js';
import { FineAlreadyPaidError, FineNotFoundError } from '../../fines/index.js';
import { InvalidMemberError } from '../../membership/index.js';
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

describe('DomainErrorFilter — Invalid* mappings', () => {
  it('maps InvalidBookError to 400', () => {
    // given the filter and a captured response
    const filter = new DomainErrorFilter();
    const response = captureResponse();

    // when an InvalidBookError is caught
    filter.catch(new InvalidBookError('title is required'), buildHost(response));

    // then the response status is 400
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'InvalidBookError',
        message: 'Invalid book: title is required',
      }),
    );
  });

  it('maps InvalidCopyError to 400', () => {
    // given the filter and a captured response
    const filter = new DomainErrorFilter();
    const response = captureResponse();

    // when an InvalidCopyError is caught
    filter.catch(new InvalidCopyError('bookId is required'), buildHost(response));

    // then the response status is 400
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'InvalidCopyError',
        message: 'Invalid copy: bookId is required',
      }),
    );
  });

  it('maps InvalidMemberError to 400', () => {
    // given the filter and a captured response
    const filter = new DomainErrorFilter();
    const response = captureResponse();

    // when an InvalidMemberError is caught
    filter.catch(new InvalidMemberError('email is required'), buildHost(response));

    // then the response status is 400
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'InvalidMemberError',
        message: 'Invalid member: email is required',
      }),
    );
  });
});
