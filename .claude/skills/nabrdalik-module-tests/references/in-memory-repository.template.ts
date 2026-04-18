// In-memory implementation of the module's repository interface. Backs every
// unit test. Same interface the Drizzle/Postgres adapter implements in production,
// so swapping substrate does not change the facade or its tests.

import type { ThingRepository } from './thing.repository.js';
import type { ThingDto, ThingId } from './thing.types.js';

// principle 5: a real in-memory implementation, not a mock. Tests exercise real logic.
// principle 6: lives inside the module folder and is not exported from index.ts.
export class InMemoryThingRepository implements ThingRepository {
  private readonly byId = new Map<ThingId, ThingDto>();

  async save(thing: ThingDto): Promise<void> {
    this.byId.set(thing.thingId, thing);
  }

  async findById(thingId: ThingId): Promise<ThingDto | undefined> {
    return this.byId.get(thingId);
  }

  async list(): Promise<ThingDto[]> {
    // principle 4: no I/O — returning from a Map stays in-process and in-milliseconds.
    return Array.from(this.byId.values());
  }
}
