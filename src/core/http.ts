import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertSafeEnvironment } from './safety/gate';
import type { Environment } from './types';
import { HOST, PORT } from './paths';

const MAX_BODY = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(payload);
}

export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        fail(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', fail);
  });
}

/**
 * Only this UI may call the API: a custom header forces a CORS preflight (which we never allow),
 * and a present Origin must be this server. Stops other websites from driving the tool.
 */
export function assertFromUi(req: IncomingMessage): void {
  if (req.headers['x-amp-ui'] !== '1') throw new HttpError(403, 'Missing UI header');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    throw new HttpError(403, 'Cross-origin request refused');
  }
}

/** Rulebook column keys and account keys: letters, digits and _ only. */
export const KEY_RE = /^[a-z0-9_]{1,40}$/;

export function environmentFrom(body: { environment?: Environment }): Environment {
  const env = body.environment;
  if (!env?.baseUrl) throw new HttpError(400, 'Base URL is required');
  let url: URL;
  try {
    url = new URL(env.baseUrl.trim());
  } catch {
    throw new HttpError(400, 'Base URL is not a valid URL');
  }
  const out: Environment = {
    name: (env.name ?? '').trim() || url.host,
    baseUrl: url.origin,
    isProduction: env.isProduction === true,
    allowProduction: env.allowProduction === true,
  };
  assertSafeEnvironment(out);
  return out;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}
