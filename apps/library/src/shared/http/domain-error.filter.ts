import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';

interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): ExpressLikeResponse;
}

import {
  BookNotFoundError,
  CopyNotFoundError,
  DuplicateIsbnError,
  InvalidBookError,
  InvalidCopyError,
} from '../../catalog/index.js';
import {
  CategoryNotFoundError,
  DuplicateCategoryError,
  InvalidCategoriesQueryError,
  InvalidCategoryError,
} from '../../categories/index.js';
import { InvalidChatRequestError } from '../../chat/index.js';
import { FineAlreadyPaidError, FineNotFoundError } from '../../fines/index.js';
import {
  CopyUnavailableError,
  LoanNotFoundError,
  MemberIneligibleError,
} from '../../lending/index.js';
import {
  DuplicateEmailError,
  InvalidMemberError,
  MemberNotFoundError,
} from '../../membership/index.js';

interface HttpErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

const NOT_FOUND_ERRORS: ReadonlyArray<new (...args: never[]) => Error> = [
  BookNotFoundError,
  CopyNotFoundError,
  MemberNotFoundError,
  LoanNotFoundError,
  FineNotFoundError,
  CategoryNotFoundError,
];

const CONFLICT_ERRORS: ReadonlyArray<new (...args: never[]) => Error> = [
  DuplicateIsbnError,
  DuplicateEmailError,
  CopyUnavailableError,
  MemberIneligibleError,
  FineAlreadyPaidError,
  DuplicateCategoryError,
];

const INVALID_REQUEST_ERRORS: ReadonlyArray<new (...args: never[]) => Error> = [
  InvalidBookError,
  InvalidCopyError,
  InvalidMemberError,
  InvalidChatRequestError,
  InvalidCategoryError,
  InvalidCategoriesQueryError,
];

@Catch(Error)
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ExpressLikeResponse>();
    const status = statusFor(error);
    const body: HttpErrorBody = {
      statusCode: status,
      error: error.name,
      message: error.message,
    };
    response.status(status).json(body);
  }
}

function statusFor(error: Error): number {
  if (isInstanceOfAny(error, NOT_FOUND_ERRORS)) {
    return HttpStatus.NOT_FOUND;
  }
  if (isInstanceOfAny(error, CONFLICT_ERRORS)) {
    return HttpStatus.CONFLICT;
  }
  if (isInstanceOfAny(error, INVALID_REQUEST_ERRORS)) {
    return HttpStatus.BAD_REQUEST;
  }
  // Nest's own HttpException still carries a status; preserve it when present.
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function isInstanceOfAny(
  error: Error,
  classes: ReadonlyArray<new (...args: never[]) => Error>,
): boolean {
  return classes.some((ctor) => error instanceof ctor);
}
