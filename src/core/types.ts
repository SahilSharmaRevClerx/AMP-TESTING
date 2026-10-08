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

export interface RulebookColumn {
  key: string;
  label: string;
  role: 'page' | 'name' | 'user' | 'info';
  /** Why an info column is not a user type. */
  reason?: string;
}

export interface Rulebook {
  /** Keys derived from the user-type column headers, e.g. "channel_manager". */
  userTypes: string[];
  /** Header text exactly as written in the sheet, e.g. "Channel Manager". */
  userTypeLabels: Record<string, string>;
  /** How every column of the sheet was understood (shown to the tester to confirm). */
  columns?: RulebookColumn[];
  /** 1-based row of the header in the sheet (title rows above it are skipped). */
  headerRow?: number;
  rules: Rule[];
}

export interface Environment {
  name: string;
  baseUrl: string;
  isProduction: boolean;
  allowProduction?: boolean;
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
