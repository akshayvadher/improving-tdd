// Sample-data builder per module. Defaults carry the "boring" fields so the test
// body stays focused on the field that matters for the scenario. Every builder
// accepts a Partial override object — tests override only what they care about.

import type { NewThingDto } from './thing.types.js';

// principle 9: one builder per new-entity DTO. Keep defaults realistic but generic.
export function sampleNewThing(overrides: Partial<NewThingDto> = {}): NewThingDto {
  return {
    name: 'Sample Thing',
    // principle 8: only fields that are crucial to every test live here.
    // Tests that care about a specific value override it; everyone else ignores it.
    ...overrides,
  };
}

// Useful when a single field is the whole point of the test — keeps call sites terse.
export function sampleNewThingNamed(name: string): NewThingDto {
  return sampleNewThing({ name });
}
