import type { Credentials, Environment, Rulebook } from './types';

/**
 * Contract between the Permission Setter and whatever opens the rulebook pages as each user
 * (today the Pages module). The setter only knows this shape; the app plugs the Pages module in.
 * That keeps both modules independent: neither imports the other.
 */

/** What one column's user saw on one rulebook page. */
export interface UserPageCheck {
  label: string;
  route: string;
  expected: string;
  verdict: string;
  state: string | null;
  reason: string;
  /** Absolute path of the screenshot, if any. */
  shot?: string;
}

export interface UserCheckInput {
  environment: Environment;
  /** The full rulebook; only `columns` are checked. */
  rulebook: Rulebook;
  rulebookSource: { name: string; data: Buffer };
  columns: string[];
  /** Column → that user's own jwt. */
  creds: Map<string, Credentials>;
  headless: boolean;
  signal?: AbortSignal;
  log: (line: string) => void;
  /** Shown as a note at the top of the check's own report. */
  note: string;
}

export interface UserCheckResult {
  runId: string;
  /** URL of the check's own report, served by the app. */
  reportUrl?: string;
  error?: string;
  /** Column → who the jwt belongs to and what they saw per page. */
  users: Record<string, { userName?: string; pages: UserPageCheck[] }>;
}

export type UserCheckRunner = (input: UserCheckInput) => Promise<UserCheckResult>;
