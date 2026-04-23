import { describe, expect, it } from 'vitest';

import type { DomainEvent } from './event-bus.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';

// These tests pin the behavioural contract of the widened EventBus port
// (AC-1.1 through AC-1.5) and the handler-error-isolation policy called out in
// the architecture doc ("publish re-throws; subsequent handlers do not run").
// Every consumer spec relies on these guarantees; exercise them here directly
// rather than leaning on indirect coverage through the consumer flow.

interface PingEvent extends DomainEvent {
  type: 'Ping';
  payload: string;
}

interface PongEvent extends DomainEvent {
  type: 'Pong';
  payload: string;
}

const ping = (payload: string): PingEvent => ({ type: 'Ping', payload });
const pong = (payload: string): PongEvent => ({ type: 'Pong', payload });

describe('InMemoryEventBus', () => {
  describe('publish (AC-1.2)', () => {
    it('resolves without error when no subscribers exist for the event type', async () => {
      const bus = new InMemoryEventBus();

      await expect(bus.publish(ping('hello'))).resolves.toBeUndefined();
    });

    it('invokes the subscribed handler with the published event', async () => {
      const bus = new InMemoryEventBus();
      const received: PingEvent[] = [];
      bus.subscribe<PingEvent>('Ping', async (event) => {
        received.push(event);
      });

      await bus.publish(ping('hello'));

      expect(received).toEqual([{ type: 'Ping', payload: 'hello' }]);
    });

    it('awaits asynchronous handlers before resolving', async () => {
      const bus = new InMemoryEventBus();
      let handlerCompleted = false;
      bus.subscribe<PingEvent>('Ping', async () => {
        // Yield once so the handler genuinely straddles an await boundary.
        await Promise.resolve();
        handlerCompleted = true;
      });

      await bus.publish(ping('x'));

      expect(handlerCompleted).toBe(true);
    });

    it('invokes multiple handlers for the same type in subscription order', async () => {
      const bus = new InMemoryEventBus();
      const order: string[] = [];
      bus.subscribe<PingEvent>('Ping', async () => {
        order.push('first');
      });
      bus.subscribe<PingEvent>('Ping', async () => {
        order.push('second');
      });
      bus.subscribe<PingEvent>('Ping', async () => {
        order.push('third');
      });

      await bus.publish(ping('x'));

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('routes events to handlers registered for the matching type only', async () => {
      const bus = new InMemoryEventBus();
      const pingCalls: string[] = [];
      const pongCalls: string[] = [];
      bus.subscribe<PingEvent>('Ping', async (event) => {
        pingCalls.push(event.payload);
      });
      bus.subscribe<PongEvent>('Pong', async (event) => {
        pongCalls.push(event.payload);
      });

      await bus.publish(ping('a'));
      await bus.publish(pong('b'));
      await bus.publish(ping('c'));

      expect(pingCalls).toEqual(['a', 'c']);
      expect(pongCalls).toEqual(['b']);
    });
  });

  describe('subscribe / unsubscribe (AC-1.5)', () => {
    it('returns an Unsubscribe that detaches only that specific handler', async () => {
      const bus = new InMemoryEventBus();
      const keptCalls: string[] = [];
      const removedCalls: string[] = [];
      const unsubscribeRemoved = bus.subscribe<PingEvent>('Ping', async (event) => {
        removedCalls.push(event.payload);
      });
      bus.subscribe<PingEvent>('Ping', async (event) => {
        keptCalls.push(event.payload);
      });

      await bus.publish(ping('first'));
      unsubscribeRemoved();
      await bus.publish(ping('second'));

      expect(removedCalls).toEqual(['first']);
      expect(keptCalls).toEqual(['first', 'second']);
    });

    it('leaves handlers for other event types untouched when one is unsubscribed', async () => {
      const bus = new InMemoryEventBus();
      const pongCalls: string[] = [];
      const unsubscribePing = bus.subscribe<PingEvent>('Ping', async () => {});
      bus.subscribe<PongEvent>('Pong', async (event) => {
        pongCalls.push(event.payload);
      });

      unsubscribePing();
      await bus.publish(pong('still-routed'));

      expect(pongCalls).toEqual(['still-routed']);
    });

    it('is safe to call the Unsubscribe twice — the second call is a no-op', async () => {
      const bus = new InMemoryEventBus();
      const calls: string[] = [];
      const other = bus.subscribe<PingEvent>('Ping', async (event) => {
        calls.push(event.payload);
      });
      const unsubscribe = bus.subscribe<PingEvent>('Ping', async () => {
        throw new Error('should have been unsubscribed');
      });

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();

      await bus.publish(ping('hello'));
      other();

      expect(calls).toEqual(['hello']);
    });
  });

  describe('re-entrant publish (AC-1.3 behavioural rule)', () => {
    it('snapshots subscribers before iterating so a handler that subscribes during fan-out is not invoked by this publish', async () => {
      const bus = new InMemoryEventBus();
      const outerCalls: string[] = [];
      const lateCalls: string[] = [];
      bus.subscribe<PingEvent>('Ping', async (event) => {
        outerCalls.push(event.payload);
        // Subscribe a NEW handler mid-fan-out. The contract says it must not
        // run as part of this publish; only subsequent publishes reach it.
        bus.subscribe<PingEvent>('Ping', async (innerEvent) => {
          lateCalls.push(innerEvent.payload);
        });
      });

      await bus.publish(ping('first'));

      // Only the original handler fires during `first`; the late subscriber
      // does not. A second publish delivers to both, including the late one.
      expect(outerCalls).toEqual(['first']);
      expect(lateCalls).toEqual([]);

      await bus.publish(ping('second'));

      // One more outer call (+1 late subscriber registered during that call
      // is itself snapshot-skipped) — so outerCalls gets 'second' but
      // lateCalls receives 'second' from the subscription made during 'first'.
      expect(outerCalls).toEqual(['first', 'second']);
      expect(lateCalls).toContain('second');
    });

    it('snapshots subscribers before iterating so a handler that unsubscribes a peer mid-fan-out does not skip it', async () => {
      const bus = new InMemoryEventBus();
      const firstCalls: string[] = [];
      const secondCalls: string[] = [];
      let unsubscribeSecond: (() => void) | undefined;
      bus.subscribe<PingEvent>('Ping', async (event) => {
        firstCalls.push(event.payload);
        unsubscribeSecond?.();
      });
      unsubscribeSecond = bus.subscribe<PingEvent>('Ping', async (event) => {
        secondCalls.push(event.payload);
      });

      await bus.publish(ping('first'));

      // Even though the first handler unsubscribed the second mid-fan-out,
      // snapshot-before-iterate ensures the second still fires for THIS
      // publish. Subsequent publishes see the detached handler gone.
      expect(firstCalls).toEqual(['first']);
      expect(secondCalls).toEqual(['first']);

      await bus.publish(ping('second'));

      expect(firstCalls).toEqual(['first', 'second']);
      expect(secondCalls).toEqual(['first']);
    });
  });

  describe('handler error isolation — re-throw, stop subsequent handlers', () => {
    // Architecture doc: "publish re-throws on handler exception. Subsequent
    // handlers for that publish do NOT run." This guards callers that rely
    // on failures surfacing rather than being silently swallowed.
    it('re-throws the handler error out of publish', async () => {
      const bus = new InMemoryEventBus();
      bus.subscribe<PingEvent>('Ping', async () => {
        throw new Error('handler exploded');
      });

      await expect(bus.publish(ping('x'))).rejects.toThrow('handler exploded');
    });

    it('does not invoke handlers registered after a throwing handler for the same publish', async () => {
      const bus = new InMemoryEventBus();
      const after: string[] = [];
      bus.subscribe<PingEvent>('Ping', async () => {
        throw new Error('first handler failed');
      });
      bus.subscribe<PingEvent>('Ping', async (event) => {
        after.push(event.payload);
      });

      await expect(bus.publish(ping('x'))).rejects.toThrow('first handler failed');

      expect(after).toEqual([]);
    });

    it('still records the event in collected() even when a handler throws', async () => {
      const bus = new InMemoryEventBus();
      bus.subscribe<PingEvent>('Ping', async () => {
        throw new Error('boom');
      });

      await expect(bus.publish(ping('x'))).rejects.toThrow('boom');

      // `collected()` runs before fan-out; observers need the audit trail even
      // on failure. Pin this as the teaching anchor: the bus is a log, not a
      // transactional channel.
      expect(bus.collected().map((event) => event.type)).toEqual(['Ping']);
    });
  });

  describe('collected() and clear() ergonomics (AC-1.4)', () => {
    it('records every successfully published event in order', async () => {
      const bus = new InMemoryEventBus();

      await bus.publish(ping('a'));
      await bus.publish(pong('b'));
      await bus.publish(ping('c'));

      expect(bus.collected().map((event) => event.type)).toEqual(['Ping', 'Pong', 'Ping']);
    });

    it('clear() resets collected() but preserves subscriptions', async () => {
      const bus = new InMemoryEventBus();
      const received: string[] = [];
      bus.subscribe<PingEvent>('Ping', async (event) => {
        received.push(event.payload);
      });
      await bus.publish(ping('before-clear'));

      bus.clear();

      expect(bus.collected()).toEqual([]);

      await bus.publish(ping('after-clear'));

      expect(received).toEqual(['before-clear', 'after-clear']);
      expect(bus.collected().map((event) => event.type)).toEqual(['Ping']);
    });
  });
});
