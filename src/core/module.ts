import type { IncomingMessage, ServerResponse } from 'node:http';

/** One request, as a testing module sees it. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
  /** The request's JSON body (read on first use). */
  body<T = Record<string, unknown>>(): Promise<T>;
  /** Sends JSON. Returns true so a route can `return ctx.json(…)`. */
  json(status: number, body: unknown): true;
}

/** How a module appears in the Testing catalog on the home page. */
export interface ModuleCard {
  title: string;
  category: string;
  description: string;
  tags: string[];
  /** Inline SVG, 26×26, using currentColor. */
  icon: string;
  /** Where Launch goes. */
  href: string;
  /** Position in the catalog (lower first). */
  order: number;
}

/** The last run of a module, shown on its catalog card. */
export interface LastRun {
  startedAt: string;
  /** Short result counts, e.g. { fail: 2, review: 1, pass: 30 }. */
  counts?: { fail: number; review: number; pass: number };
}

/**
 * A testing module (Pages, Permission Setter, MCP …). Each one lives in its own folder under
 * src/modules/ and only imports src/core/. The app (src/app/) registers them and runs them all
 * from one server; nothing in one module imports another.
 */
export interface TestModule {
  id: string;
  card?: ModuleCard;
  /** HTML pages this module serves: URL path → absolute file path. */
  pages?: Record<string, string>;
  /**
   * GET routes anyone may read without the UI header (page data, history, live progress).
   * Every other /api/ request must come from the tool's own pages (checked by the app).
   */
  isPublic?(method: string, path: string): boolean;
  /** Requests only shown in the log with --debug. */
  isRoutine?(method: string, path: string): boolean;
  /** Handles the request if it belongs to this module; returns false if not. */
  handle(ctx: Ctx): Promise<boolean>;
  /** For the catalog card. */
  lastRun?(): LastRun | null;
}
