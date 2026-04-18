import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import type { MembershipTier, NewMemberDto } from '../../../src/membership/membership.types.js';

type Agent = ReturnType<typeof request>;
type HttpCall = ReturnType<Agent['get']>;

function server(app: INestApplication): Agent {
  return request(app.getHttpServer());
}

export function postNewMember(app: INestApplication, dto: NewMemberDto): HttpCall {
  return server(app).post('/members').send(dto);
}

export function getMember(app: INestApplication, memberId: string): HttpCall {
  return server(app).get(`/members/${memberId}`);
}

export function suspendMember(app: INestApplication, memberId: string): HttpCall {
  return server(app).patch(`/members/${memberId}/suspend`);
}

export function reactivateMember(app: INestApplication, memberId: string): HttpCall {
  return server(app).patch(`/members/${memberId}/reactivate`);
}

export function upgradeMemberTier(
  app: INestApplication,
  memberId: string,
  tier: MembershipTier,
): HttpCall {
  return server(app).patch(`/members/${memberId}/tier`).send({ tier });
}

export function getMemberEligibility(app: INestApplication, memberId: string): HttpCall {
  return server(app).get(`/members/${memberId}/eligibility`);
}
