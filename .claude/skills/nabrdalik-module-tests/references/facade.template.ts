// Canonical facade shape. One class per module, @Injectable, constructor-injected
// collaborators. Named error classes so tests can assert on the specific failure mode.
// Rename Thing / NewThingDto / ThingRepository to your domain and compile.

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { ThingRepository } from './thing.repository.js';
import {
  ThingNotFoundError,
  type NewThingDto,
  type ThingDto,
  type ThingId,
} from './thing.types.js';

type IdGenerator = () => string;

// principle 3: the module's single public entry point — the facade class.
// principle 6: no method accepts a repository — collaborators arrive via the constructor only.
@Injectable()
export class ThingFacade {
  constructor(
    private readonly repository: ThingRepository,
    private readonly newId: IdGenerator = randomUUID,
  ) {}

  async addThing(dto: NewThingDto): Promise<ThingDto> {
    const thing: ThingDto = { thingId: this.newId(), name: dto.name };
    await this.repository.save(thing);
    return thing;
  }

  async findThing(thingId: ThingId): Promise<ThingDto> {
    const thing = await this.repository.findById(thingId);
    // principle 1: throw a named domain error — tests assert on the type, not a string message.
    if (!thing) {
      throw new ThingNotFoundError(thingId);
    }
    return thing;
  }

  listThings(): Promise<ThingDto[]> {
    return this.repository.list();
  }
}
