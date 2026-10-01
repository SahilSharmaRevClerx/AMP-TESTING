import type { RequestGate } from '../safety/gate';
import type { Credentials, Identity } from '../types';
import { validateToken } from '../sessions/validate';
import type { AmpModule } from './sliders';

export interface AdminCheck {
  identity: Identity;
  /** True when AMP let this user read the Navigation Layout (only Site/Super Admins can). */
  isAdmin: boolean;
  modules: AmpModule[];
  reason?: string;
}

const USER = 'super_admin';

/**
 * Confirms the jwt is live and belongs to a Site/Super Admin, and reads the company's modules
 * (name + url) in the same go. GetModulesForNavigationLayout refuses anyone else, which makes it
 * the admin check too (getpermissiondataforuser only reports Site Admin, not Super Admin).
 */
export async function checkSuperAdmin(gate: RequestGate, creds: Credentials): Promise<AdminCheck> {
  const identity = await validateToken(gate, USER, creds);
  if (!identity.valid) return { identity, isAdmin: false, modules: [], reason: identity.reason };

  const notAdmin = (why: string): AdminCheck => ({
    identity,
    isAdmin: false,
    modules: [],
    reason: `${identity.userName ?? 'this user'} is not a Super Admin (${why}); paste the Super Admin's jwt`,
  });
  let body: unknown;
  try {
    const res = await gate.fetch(USER, 'POST', gate.resolve('/services/api.ashx?func=getmodulesfornavigationlayout'), creds, {});
    if (!res.ok) return notAdmin(`module list: HTTP ${res.status}`);
    body = await res.json();
  } catch (e) {
    return notAdmin(`module list: ${(e as Error).message}`);
  }
  const result = (body as { result?: unknown })?.result as { modulesArray?: unknown } | undefined;
  if (!result || !Array.isArray(result.modulesArray)) return notAdmin('AMP refused the module list');
  return { identity, isAdmin: true, modules: parseModules(result.modulesArray) };
}

export function parseModules(list: unknown[]): AmpModule[] {
  const out: AmpModule[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (r.isgroup === true || typeof r.name !== 'string') continue;
    out.push({
      id: Number(r.id) || 0,
      name: r.name,
      url: typeof r.url === 'string' ? r.url : '',
      label: typeof r.defaultlocalization === 'string' ? r.defaultlocalization : undefined,
    });
  }
  return out;
}
