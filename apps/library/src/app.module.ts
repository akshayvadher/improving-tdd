import { Module } from '@nestjs/common';

import { CatalogModule } from './catalog/catalog.module.js';
import { DatabaseModule } from './db/database.module.js';
import { FinesModule } from './fines/fines.module.js';
import { LendingModule } from './lending/lending.module.js';
import { MembershipModule } from './membership/membership.module.js';

@Module({
  imports: [DatabaseModule, CatalogModule, MembershipModule, LendingModule, FinesModule],
})
export class AppModule {}
