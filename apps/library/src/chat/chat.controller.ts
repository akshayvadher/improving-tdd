import { Body, Controller, Post, Sse, type MessageEvent } from '@nestjs/common';
import { from, map, type Observable } from 'rxjs';

import { ChatFacade } from './chat.facade.js';
import type { ChatFrame } from './chat.types.js';

// Decorator composition: `@Post() @Sse()` is used.
//
// `@Sse()` sets the `SSE_METADATA` flag that Nest's router-execution-context
// uses to route the handler's return value through the SSE response pipeline.
// By default `@Sse()` also seeds the HTTP method to GET, but `@Post()` is
// applied AFTER `@Sse()` (decorators execute bottom-up, but mapping decorators
// overwrite `METHOD_METADATA` when they run) — so the final route resolves to
// POST while the SSE metadata stays. Nest 10.4 handles this composition:
// `createHandleResponseFn` reads `SSE_METADATA` regardless of HTTP method and
// pipes the Observable result through `router-response-controller.sse`.
//
// Verified empirically against @nestjs/common 10.4.22. Re-verify on upgrade
// to 11.x — decorator metadata handling may tighten.
@Controller('chat')
export class ChatController {
  constructor(private readonly facade: ChatFacade) {}

  @Post()
  @Sse()
  streamChat(@Body() body: unknown): Observable<MessageEvent> {
    return from(this.facade.streamChat(body)).pipe(map((frame) => this.toMessageEvent(frame)));
  }

  private toMessageEvent(frame: ChatFrame): MessageEvent {
    if (frame.type === 'delta') {
      return { type: 'delta', data: { text: frame.text } };
    }
    if (frame.type === 'error') {
      return { type: 'error', data: { message: frame.message } };
    }
    return { type: 'done', data: {} };
  }
}
