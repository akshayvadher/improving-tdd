import { Module } from '@nestjs/common';

import { AccessControlFacade } from './access-control.facade.js';

@Module({
  providers: [AccessControlFacade],
  exports: [AccessControlFacade],
})
export class AccessControlModule {}
