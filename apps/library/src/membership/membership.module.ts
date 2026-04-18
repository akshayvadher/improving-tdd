import { Module } from '@nestjs/common';

import { DATABASE, DatabaseModule } from '../db/database.module.js';
import type { AppDatabase } from '../db/client.js';
import { DrizzleMembershipRepository } from './drizzle-membership.repository.js';
import { MembershipController } from './membership.controller.js';
import { MembershipFacade } from './membership.facade.js';

const MEMBERSHIP_REPOSITORY = Symbol('MembershipRepository');

@Module({
  imports: [DatabaseModule],
  controllers: [MembershipController],
  providers: [
    {
      provide: MEMBERSHIP_REPOSITORY,
      useFactory: (db: AppDatabase) => new DrizzleMembershipRepository(db),
      inject: [DATABASE],
    },
    {
      provide: MembershipFacade,
      useFactory: (repository: DrizzleMembershipRepository) => new MembershipFacade(repository),
      inject: [MEMBERSHIP_REPOSITORY],
    },
  ],
  exports: [MembershipFacade],
})
export class MembershipModule {}
