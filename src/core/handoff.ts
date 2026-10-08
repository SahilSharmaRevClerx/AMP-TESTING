import { randomUUID } from 'node:crypto';
import type { Environment } from './types';
import { createLogger } from './util/logger';

const log = createLogger('handoff');

/**
 * One module passing a finished run to another, e.g. Permission Setter → "Verify in Pages Testing".
 * Memory only, for HANDOFF_MINUTES. The user jwts in it are never sent back to a page; the
 * receiving page only refers to them by hand-off id.
 */
export interface Handoff {
  id: string;
  expiresAt: number;
  environment: Environment;
  rulebookId: string;
  /** Rulebook columns the hand-off is about (e.g. whose roles were saved). */
  columns: string[];
  /** Column → AMP role name. */
  roles: Record<string, string>;
  /** The run that left the hand-off. */
  sourceRunId: string;
  /** Column → that user's jwt. */
  jwts: Map<string, string>;
}

export const HANDOFF_MINUTES = 15;
const handoffs = new Map<string, Handoff>();

export function createHandoff(h: Omit<Handoff, 'id' | 'expiresAt'>): string {
  const id = randomUUID();
  handoffs.set(id, { ...h, id, expiresAt: Date.now() + HANDOFF_MINUTES * 60_000 });
  setTimeout(() => dropHandoff(id), HANDOFF_MINUTES * 60_000).unref();
  return id;
}

export function getHandoff(id: string | undefined): Handoff | null {
  if (!id) return null;
  const h = handoffs.get(id);
  if (!h) return null;
  if (Date.now() > h.expiresAt) {
    dropHandoff(h.id);
    return null;
  return h;
}

export function dropHandoff(id: string): void {
  const h = handoffs.get(id);
  if (!h) return;
  h.jwts.clear();
  handoffs.delete(id);
  log.debug('handoff dropped', { id });
}
