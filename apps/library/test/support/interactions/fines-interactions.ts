import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

type Agent = ReturnType<typeof request>;
type HttpCall = ReturnType<Agent['get']>;

function server(app: INestApplication): Agent {
  return request(app.getHttpServer());
}

export function assessFinesFor(app: INestApplication, memberId: string): HttpCall {
  return server(app).post(`/members/${memberId}/fines/assessments`);
}

export function processOverdueLoans(app: INestApplication): HttpCall {
  return server(app).post('/fines/batch/process');
}

export function listFinesFor(app: INestApplication, memberId: string): HttpCall {
  return server(app).get(`/members/${memberId}/fines`);
}

export function findFine(app: INestApplication, fineId: string): HttpCall {
  return server(app).get(`/fines/${fineId}`);
}

export function payFine(app: INestApplication, fineId: string): HttpCall {
  return server(app).patch(`/fines/${fineId}/paid`);
}
