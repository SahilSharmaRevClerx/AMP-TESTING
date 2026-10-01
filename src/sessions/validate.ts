import type { RequestGate } from '../safety/gate';
import type { Credentials, Identity } from '../types';
import { isLoginPath, urlPath } from '../util/route';

/**
 * Confirms a token pair is live and reports who it belongs to, using AMP's
 * read-only getpermissiondataforuser API (same call the AMP UI makes on load).
 */
export async function validateToken(gate: RequestGate, userType: string, creds: Credentials): Promise<Identity> {
  const url = gate.resolve('/services/api.ashx?func=getpermissiondataforuser');
  let res: Response;
  try {
    res = await gate.fetch(userType, 'POST', url, creds, {});
  } catch (e) {
    return { userType, valid: false, reason: `request failed: ${(e as Error).message}` };
  }

  if (res.status === 401) return { userType, valid: false, reason: 'not authenticated (401) - token expired or wrong' };
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    const path = urlPath(new URL(loc, gate.baseUrl).href);
    return {
      userType,
      valid: false,
      reason: isLoginPath(path) ? `redirected to ${path} - token expired or wrong` : `unexpected redirect to ${loc}`,
    };
  }
  if (!res.ok) return { userType, valid: false, reason: `HTTP ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { userType, valid: false, reason: 'response was not JSON' };
  }
  const result = (body as { result?: unknown })?.result;
  if (!result || typeof result !== 'object') {
    return { userType, valid: false, reason: `API refused: ${JSON.stringify(result ?? body).slice(0, 120)}` };
  }
  const r = result as Record<string, unknown>;
  if ('code' in r && 'message' in r && !('userName' in r)) {
    return { userType, valid: false, reason: `API error: ${String(r.message).slice(0, 120)}` };
  }

  return {
    userType,
    valid: true,
    userName: str(r.userName),
    isSiteAdmin: r.isSiteAdmin === true,
    persona: str(r.personna),
    personaOption: str(r.personnaOption),
    isCompanyLevelUser: r.isCompanyLevelUser === true,
    organizationId: typeof r.organizationID === 'number' ? r.organizationID : undefined,
    organizationName: str(r.organizationName),
    companyName: str(r.userCompanyName),
    ampVersion: str((body as { version?: unknown }).version),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * User types whose jwt belongs to the same person as an earlier one (same name in the same
 * organization/company), e.g. both rows pasted from the Super Admin's session. Testing the same
 * person twice makes every comparison meaningless. Returns duplicate → the user type it repeats.
 */
export function duplicateIdentities(ids: Identity[]): Map<string, string> {
  const seen = new Map<string, string>();
  const dups = new Map<string, string>();
  for (const id of ids) {
    if (!id.valid || !id.userName) continue;
    const key = `${id.userName.trim().toLowerCase()}|${id.organizationId ?? id.companyName ?? ''}`;
    const first = seen.get(key);
    if (first) dups.set(id.userType, first);
    else seen.set(key, id.userType);
  }
  return dups;
}

export function describeIdentity(id: Identity): string {
  if (!id.valid) return `INVALID - ${id.reason}`;
  const where = id.organizationName ? `org "${id.organizationName}"` : id.companyName ? `company "${id.companyName}"` : 'company-level';
  const persona = id.persona ? `persona ${id.persona}${id.personaOption ? `/${id.personaOption}` : ''}` : 'no persona';
  return `${id.userName ?? '(unknown name)'} | ${persona} | ${where}${id.isSiteAdmin ? ' | SITE ADMIN' : ''}`;
}
