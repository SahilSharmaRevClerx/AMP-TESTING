import type { Environment, Expected, RuleType } from '../../core/types';

export interface RunConfig {
  environment: Environment;
  rulebook: string;
  shellPath: string;
  /** Reference user (Site Admin) whose run defines what each page looks like. Null = each user is its own reference. */
  calibrationUserType: string | null;
  userTypes: Record<string, { label: string }>;
  delayMs: number;
  pageTimeoutMs: number;
  settleMs: number;
  fingerprintThreshold: number;
  /** User types tested at the same time, each in its own browser (1–5; always 1 on production). */
  parallelUsers: number;
  headless: boolean;
  outputDir: string;
  /** Save step-by-step screenshots and a written decision per page (debug/<run>/<user>/...). */
  debugShots?: boolean;
  /** Where debug runs go (git-ignored). */
  debugDir?: string;
}

export interface MenuLink {
  name: string;
  link: string;
  key: string;
}

export interface MenuResult {
  userType: string;
  ok: boolean;
  reason?: string;
  links: MenuLink[];
}

export type AccessState =
  | 'OPENED'
  | 'BLOCKED'
  | 'OPENED_EMPTY'
  /** Only the AMP frame rendered: no page content, no data, no explicit denial. */
  | 'BLANK'
  | 'BAD_TOKEN'
  | 'ERROR'
  | 'NOT_FOUND'
  | 'UNCLEAR';

export interface ApiCall {
  func: string;
  httpStatus: number;
  apiStatus: number | null;
  /** Response shape says access was denied (401, "Not authorized.", or {code, message}). */
  denied: boolean;
  /** The call succeeded and returned data (a non-empty list or object). */
  hasData?: boolean;
}

export interface PageEvidence {
  route: string;
  finalUrl: string;
  fragmentStatus: number | null;
  fragmentRedirect: string | null;
  noAccessMarker: boolean;
  /** A short visible message such as "You do not have permission to view this page", if any. */
  denialText?: string;
  /** A short visible failure message such as "Something went wrong", if any. */
  errorText?: string;
  /** The page's own "nothing here yet" message, e.g. "No Data Found" (the page rendered, it just has no rows). */
  emptyText?: string;
  /** Text of AMP's "page not found" screen, e.g. "Looks like you're lost" / "ERROR CODE: 404". */
  notFoundText?: string;
  /** The wait ran out while AMP requests were still running or a loading spinner was visible. */
  stillLoading?: boolean;
  /** How the wait for the page went, one line per sample (for debugging). */
  waitLog?: string[];
  /** Folder with this page's step-by-step debug screenshots, if saved. */
  debugDir?: string | null;
  apiCalls: ApiCall[];
  blockedRequests: string[];
  pageErrors: string[];
  textLength: number;
  /** Fingerprint tokens seen on screen: "id:<id>" and "h:<heading text>". */
  tokens: string[];
  title: string;
  screenshot: string | null;
  error?: string;
  durationMs: number;
}

export interface Fingerprint {
  route: string;
  tokens: string[];
  apiFuncs: string[];
  /** apiStatus the reference user got per func, used to spot denials for other users. */
  apiStatus: Record<string, number | null>;
  usable: boolean;
  reason?: string;
}

export type Verdict =
  | 'PASS'
  | 'FAIL_SECURITY_GAP'
  | 'FAIL_EXTRA_ACCESS'
  | 'FAIL_MISSING_ACCESS'
  | 'FAIL_OPENS_EMPTY'
  | 'REVIEW'
  | 'NOT_SPECIFIED';

export interface CheckResult {
  ruleId: string;
  label: string;
  parent: string;
  route: string;
  type: RuleType;
  userType: string;
  expected: Expected;
  /** The page itself is a link in the user's menu (a page under it doesn't count). */
  inMenu: boolean;
  state: AccessState | null;
  fingerprintScore: number | null;
  verdict: Verdict;
  reason: string;
  evidence?: PageEvidence;
}
