import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleNewMember } from '../src/membership/sample-membership-data.js';
import { MembershipStatus } from '../src/membership/membership.types.js';
import { createTestApp } from './support/app-factory.js';
import {
  getMemberEligibility,
  postNewMember,
  suspendMember,
} from './support/interactions/membership-interactions.js';
import {
  DOCKER_UNAVAILABLE_MESSAGE,
  dockerIsAvailable,
} from './support/require-docker.js';
import { startPostgres, type PostgresFixture } from './support/testcontainers.js';

const suite = dockerIsAvailable() ? describe : describe.skip;
if (!dockerIsAvailable()) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${DOCKER_UNAVAILABLE_MESSAGE}`);
}

suite('Membership crucial path (HTTP + Postgres)', () => {
  let fixture: PostgresFixture;
  let app: INestApplication;

  beforeAll(async () => {
    fixture = await startPostgres();
    app = await createTestApp({ databaseUrl: fixture.connectionUrl });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (fixture) {
      await fixture.stop();
    }
  });

  it('registers a member, suspends them, and eligibility reflects the suspension', async () => {
    // given a new member registers
    const registerResponse = await postNewMember(
      app,
      sampleNewMember({ email: 'grace.hopper@example.com' }),
    );
    expect(registerResponse.status).toBe(201);
    const member = registerResponse.body;
    expect(member.status).toBe(MembershipStatus.ACTIVE);

    // when the member is suspended
    const suspendResponse = await suspendMember(app, member.memberId);

    // then their status is SUSPENDED and eligibility reports the reason
    expect(suspendResponse.status).toBe(200);
    expect(suspendResponse.body.status).toBe(MembershipStatus.SUSPENDED);

    const eligibilityResponse = await getMemberEligibility(app, member.memberId);
    expect(eligibilityResponse.status).toBe(200);
    expect(eligibilityResponse.body).toEqual({
      memberId: member.memberId,
      eligible: false,
      reason: 'SUSPENDED',
    });
  });
});
