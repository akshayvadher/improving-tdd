import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

type Agent = ReturnType<typeof request>;
type HttpCall = ReturnType<Agent['get']>;

function server(app: INestApplication): Agent {
  return request(app.getHttpServer());
}

export function borrowCopy(app: INestApplication, memberId: string, copyId: string): HttpCall {
  return server(app).post('/loans').send({ memberId, copyId });
}

export function returnLoan(app: INestApplication, loanId: string): HttpCall {
  return server(app).patch(`/loans/${loanId}/return`);
}

export function reserveBook(app: INestApplication, memberId: string, bookId: string): HttpCall {
  return server(app).post('/reservations').send({ memberId, bookId });
}

export function listOverdueLoans(app: INestApplication, now?: Date): HttpCall {
  const req = server(app).get('/loans/overdue');
  return now ? req.query({ now: now.toISOString() }) : req;
}

export function listActiveLoansWithQueuedReservations(app: INestApplication): HttpCall {
  return server(app).get('/loans/active-with-reservation-counts');
}

export function listLoansFor(app: INestApplication, memberId: string): HttpCall {
  return server(app).get(`/members/${memberId}/loans`);
}
