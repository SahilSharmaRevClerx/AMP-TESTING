import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrub } from './mask';

export interface AuditEntry {
  source: 'tool' | 'browser';
  userType: string;
  method: string;
  url: string;
  decision: 'allowed' | 'blocked';
  reason?: string;
  status?: number;
}

/** Append-only JSON-lines log of every request the tool makes or lets the browser make. */
export class AuditLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(this.file, scrub(line) + '\n');
  }
}
