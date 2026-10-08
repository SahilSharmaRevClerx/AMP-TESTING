import { randomUUID } from 'node:crypto';
import { HttpError } from './http';
import type { Rulebook } from './types';

/** A rulebook the tester picked or uploaded in a page, kept in memory by id. */
export interface LoadedRulebook {
  id: string;
  name: string;
  /** The original file, copied into run folders for traceability. */
  data: Buffer;
  rulebook: Rulebook;
}

const rulebooks = new Map<string, LoadedRulebook>();

export function addRulebook(name: string, data: Buffer, rulebook: Rulebook): LoadedRulebook {
  const loaded = { id: randomUUID(), name, data, rulebook };
  rulebooks.set(loaded.id, loaded);
  return loaded;
}

export function findRulebook(id: string): LoadedRulebook | null {
  return rulebooks.get(id) ?? null;
}

export function getRulebook(id: string): LoadedRulebook {
  const rb = rulebooks.get(id);
  if (!rb) throw new HttpError(400, 'Rulebook not loaded; select or upload it again');
  return rb;
}
