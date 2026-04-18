// Common-interactions helper for integration tests. Hides HTTP verb, path,
// payload, and serialization so test bodies read as business intent, not as HTTP.

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import type { NewThingDto } from '../../../src/thing/thing.types.js';

type Agent = ReturnType<typeof request>;
type HttpCall = ReturnType<Agent['get']>;

// principle 10: one place to change the endpoint or the payload shape.
// Tests never repeat `.post('/things').send(...)` — they say postNewThing(app, dto).
function server(app: INestApplication): Agent {
  return request(app.getHttpServer());
}

export function postNewThing(app: INestApplication, dto: NewThingDto): HttpCall {
  return server(app).post('/things').send(dto);
}

export function getThing(app: INestApplication, thingId: string): HttpCall {
  return server(app).get(`/things/${encodeURIComponent(thingId)}`);
}

export function listThings(app: INestApplication): HttpCall {
  return server(app).get('/things');
}
