import { apiFuncsFromUrl, decideBrowserRequest, isApiEndpoint, type Decision } from '../../core/safety/gate';

/** The one write the Permission Setter may let the browser make: saving the role it edited. */
export const SETTER_WRITE_API = 'saverole';
/** The Navigation Layout step's writes: link/unlink a user to a module, and save the module's "Shown to" setting. */
export const SETTER_NAV_APIS = new Set(['togglemodulesettinglink', 'updatemodulesetting']);

/**
 * Policy for the Permission Setter's browser (logged in as the Super Admin): the shared read-only
 * policy, plus SaveRole and the Navigation Layout writes when the tester chose "Apply". Every other
 * write stays blocked.
 */
export function decideSetterRequest(method: string, rawUrl: string, baseHost: string, allowSave: boolean): Decision {
  let url: URL | null = null;
  try {
    url = new URL(rawUrl);
  } catch {
    /* handled below */
  }
  if (url && method.toUpperCase() === 'POST' && url.host.toLowerCase() === baseHost && isApiEndpoint(url)) {
    const funcs = apiFuncsFromUrl(url);
    if (funcs.length === 1 && funcs[0] === SETTER_WRITE_API) {
      return allowSave ? { allowed: true, reason: 'role save (apply)' } : { allowed: false, reason: 'role save blocked (preview only)' };
    }
    if (funcs.length === 1 && SETTER_NAV_APIS.has(funcs[0]!)) {
      return allowSave ? { allowed: true, reason: 'navigation layout setting (apply)' } : { allowed: false, reason: 'navigation layout change blocked (preview only)' };
    }
  }
  return decideBrowserRequest(method, rawUrl, baseHost);
}
