export type Expected = 'Yes' | 'No' | null;
export type RuleType = 'page' | 'group' | 'external';

export interface Rule {
  id: string;
  type: RuleType;
  parent: string;
  label: string;
  /** Normalized hash route without leading "/#", e.g. "setup/roles". Empty for groups. */
  route: string;
  expected: Record<string, Expected>;
  notes: string;
}

export interface Rulebook {
  userTypes: string[];
  rules: Rule[];
}

export interface Environment {
  name: string;
  baseUrl: string;
  isProduction: boolean;
  allowProduction?: boolean;
}

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
  headless: boolean;
  outputDir: string;
}

export interface Credentials {
  jwt: string;
  csrf: string;
}

export interface Identity {
  userType: string;
  valid: boolean;
  reason?: string;
  userName?: string;
  isSiteAdmin?: boolean;
  persona?: string;
  personaOption?: string;
  isCompanyLevelUser?: boolean;
  organizationId?: number;
  organizationName?: string;
  companyName?: string;
  /** AMP build (Installs.Commit) reported in the API response. */
  ampVersion?: string;
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
}

export interface PageEvidence {
  route: string;
  finalUrl: string;
  fragmentStatus: number | null;
  fragmentRedirect: string | null;
  noAccessMarker: boolean;
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
  /** apiStatus the calibration user got per func, used to spot denials for other users. */
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
  inMenu: boolean;
  state: AccessState | null;
  fingerprintScore: number | null;
  verdict: Verdict;
  reason: string;
  evidence?: PageEvidence;
}
