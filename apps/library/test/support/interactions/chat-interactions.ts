import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';

export interface SseFrame {
  event: string;
  data: unknown;
}

export interface SseResponse {
  status: number;
  contentType: string;
  frames: SseFrame[];
  rawBody: string;
}

export async function streamChat(app: INestApplication, body: unknown): Promise<SseResponse> {
  const response = await request(app.getHttpServer())
    .post('/chat')
    .set('Accept', 'text/event-stream')
    .set('Content-Type', 'application/json')
    .send(body as object)
    .buffer(true)
    .parse(collectRawBody);

  const rawBody = typeof response.body === 'string' ? response.body : (response.text ?? '');
  const contentType = String(response.headers['content-type'] ?? '');
  const frames = contentType.includes('text/event-stream') ? parseSseFrames(rawBody) : [];

  return { status: response.status, contentType, frames, rawBody };
}

function collectRawBody(res: Response, callback: (err: Error | null, body: string) => void): void {
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk: string) => {
    body += chunk;
  });
  res.on('end', () => callback(null, body));
  res.on('error', (error) => callback(error, body));
}

function parseSseFrames(rawBody: string): SseFrame[] {
  const normalized = rawBody.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n').filter((block) => block.trim().length > 0);
  return blocks.map(parseFrameBlock).filter((frame): frame is SseFrame => frame !== null);
}

function parseFrameBlock(block: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (!event || dataLines.length === 0) {
    return null;
  }
  const raw = dataLines.join('\n');
  return { event, data: parseFrameData(raw) };
}

function parseFrameData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
