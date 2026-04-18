// Facade spec template. Wires the facade through the module's factory — no Nest
// container, no Test.createTestingModule. Deterministic ids make assertions cheap.
// Three tests: happy path, error case, state query through the facade.

import { describe, expect, it } from 'vitest';

import { createThingFacade } from './thing.configuration.js';
import { ThingNotFoundError } from './thing.types.js';
import { sampleNewThing } from './sample-thing-data.js';

// principle 8: deterministic ids keep assertions minimal — no regex, no matchers.
function sequentialIds(prefix = 'thing'): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function buildFacade() {
  // principle 6: the factory wires its own in-memory deps. Tests do not reach for the repo.
  return createThingFacade({ newId: sequentialIds() });
}

describe('ThingFacade', () => {
  it('adds a thing and finds it by id', async () => {
    // given a facade wired with in-memory deps
    const facade = buildFacade();

    // when a thing is added
    const added = await facade.addThing(sampleNewThing({ name: 'Alpha' }));

    // then it is retrievable through the facade — principle 5 in action.
    expect(await facade.findThing(added.thingId)).toEqual(added);
  });

  it('throws ThingNotFoundError when the id is unknown', async () => {
    // given an empty facade
    const facade = buildFacade();

    // when / then — principle 1: assert on the domain error type, not internal state.
    await expect(facade.findThing('unknown-id')).rejects.toThrow(ThingNotFoundError);
  });

  it('lists things in insertion order', async () => {
    // given a facade with two things
    const facade = buildFacade();
    const first = await facade.addThing(sampleNewThing({ name: 'Alpha' }));
    const second = await facade.addThing(sampleNewThing({ name: 'Beta' }));

    // when listing through the facade — no peeking at the Map.
    const things = await facade.listThings();

    // then both appear in the order they were added
    expect(things).toEqual([first, second]);
  });
});
