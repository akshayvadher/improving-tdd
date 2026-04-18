import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import type { NewBookDto, NewCopyDto } from '../../../src/catalog/catalog.types.js';

type Agent = ReturnType<typeof request>;
type HttpCall = ReturnType<Agent['get']>;

function server(app: INestApplication): Agent {
  return request(app.getHttpServer());
}

export function postNewBook(app: INestApplication, dto: NewBookDto): HttpCall {
  return server(app).post('/books').send(dto);
}

export function getBook(app: INestApplication, isbn: string): HttpCall {
  return server(app).get(`/books/${encodeURIComponent(isbn)}`);
}

export function listBooks(app: INestApplication): HttpCall {
  return server(app).get('/books');
}

export function registerCopy(
  app: INestApplication,
  bookId: string,
  dto: NewCopyDto,
): HttpCall {
  return server(app).post(`/books/${bookId}/copies`).send(dto);
}

export function markCopyAvailable(app: INestApplication, copyId: string): HttpCall {
  return server(app).patch(`/copies/${copyId}/available`);
}

export function markCopyUnavailable(app: INestApplication, copyId: string): HttpCall {
  return server(app).patch(`/copies/${copyId}/unavailable`);
}
