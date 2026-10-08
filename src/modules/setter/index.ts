import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiKeySet, aiModel } from '../../core/ai/gemini';
import type { UserCheckRunner } from '../../core/contracts';
import { makeCredentials } from '../../core/credentials';
import { createHandoff, getHandoff, HANDOFF_MINUTES } from '../../core/handoff';
import { clamp, environmentFrom, HttpError } from '../../core/http';
import type { TestModule } from '../../core/module';
import { OUTPUT_DIR } from '../../core/paths';
import { getRulebook, type LoadedRulebook } from '../../core/rulebooks';
import { RequestGate } from '../../core/safety/gate';
import type { Credentials, Environment, Rulebook } from '../../core/types';
import { AuditLog } from '../../core/util/audit';
import { createLogger } from '../../core/util/logger';
import { forgetSecrets, scrub } from '../../core/util/mask';
import { prepareNavigation } from './navrun';
import { executeSetter, newSetterRunId, planAll, type SetterOutcome } from './run';
import { checkSuperAdmin } from './session';
import { LEVELS } from './sliders';

/**
 * Permission Setter: moves AMP role sliders (as the Super Admin) to match the rulebook, then
 * checks the pages as each column's user. Changes AMP. Page: /setter. API: /api/setter/…
 */

const log = createLogger('server');
const SETTER_FILE = fileURLToPath(new URL('./setter.html', import.meta.url));
/** Setter reports: output/_setter/<run>/. */
export const SETTER_DIR = join(OUTPUT_DIR, '_setter');

interface SetterBody {
  environment?: Environment;
  rulebookId?: string;
  jwt?: string;
  roles?: Record<string, string>;
  /** "Set every slider": one role and a level 0–4, no rulebook. */
  bulk?: { roleName?: string; step?: number };
  apply?: boolean;
  headed?: boolean;
  /** Rulebook column → that user's own jwt: after saving, log in as them and open the rulebook pages. */
  users?: Record<string, string>;
  /** Send results and screenshots to Gemini for a second check. */
  ai?: boolean;
  /** Pause after every step in AMP's role editor, in seconds. */
  stepDelaySec?: number;
  /** Use Navigation Layout for pages role sliders can't hide (default on). */
  navigation?: boolean;
  /** Rulebook column → that column's AMP user (email or name), for Navigation Layout. */
  userHints?: Record<string, string>;
}

/** The Permission Setter's run (one at a time; the UI polls it). */
interface SetterState {
  id: string;
  status: 'running' | 'done' | 'failed';
  apply: boolean;
  lines: string[];
  outcome: SetterOutcome | null;
  controller: AbortController;
  /** Set after a rulebook Apply: lets Pages Testing pick up this run. */
  handoffId?: string;
}

export interface SetterDeps {
  /** Opens the rulebook pages as each column's user after Apply (the app plugs in the Pages module). */
  checkAsUsers: UserCheckRunner;
}

export function createSetterModule(deps: SetterDeps): TestModule {
  let setter: SetterState | null = null;

  function setterState(from = 0) {
    if (!setter) return null;
    const o = setter.outcome;
    return {
      id: setter.id,
      status: setter.status,
      apply: setter.apply,
      lines: setter.lines.slice(Math.max(0, from)),
      lineCount: setter.lines.length,
      outcome: o && {
        error: o.error ?? null,
        roles: o.roles.map((r) => ({
          label: r.label,
          roleName: r.roleName,
          status: r.status,
          error: r.error ?? null,
          changed: r.controls.filter((c) => c.changed).length,
          userCheck: r.userCheck ? { pass: r.userCheck.pages.filter((p) => p.verdict === 'PASS').length, total: r.userCheck.pages.length } : null,
          ai: r.ai ? r.ai.verdict : r.aiError ? `error: ${r.aiError}` : null,
        })),
        reportUrl: o.reportFile ? `/output/_setter/${setter.id}/report.html` : null,
        verifyReportUrl: o.verify?.reportUrl ?? null,
        handoffId: setter.handoffId && getHandoff(setter.handoffId) ? setter.handoffId : null,
        handoffMinutes: HANDOFF_MINUTES,
      },
    };
  }

  async function startSetter(body: SetterBody, env: Environment, creds: Credentials, forget: () => void) {
    const userCreds = new Map<string, Credentials>();
    const forgetAll = () => {
      forget();
      forgetSecrets([...userCreds.values()].flatMap((c) => [c.jwt, c.csrf]));
    };
    let loaded: LoadedRulebook | null = null;
    let roles: Record<string, string> = {};
    let bulk: { roleName: string; step: 0 | 1 | 2 | 3 | 4 } | undefined;
    try {
      if (setter?.status === 'running') throw new HttpError(409, 'A permission run is already in progress');
      if (body.bulk) {
        const roleName = body.bulk.roleName?.trim().slice(0, 200);
        const step = Number(body.bulk.step);
        if (!roleName) throw new HttpError(400, 'Enter the AMP role name');
        if (![0, 1, 2, 3, 4].includes(step)) throw new HttpError(400, 'Choose a level');
        bulk = { roleName, step: step as 0 | 1 | 2 | 3 | 4 };
      } else {
        loaded = getRulebook(body.rulebookId ?? '');
        roles = setterRoles(body, loaded.rulebook);
        for (const ut of Object.keys(roles)) {
          const jwt = body.users?.[ut]?.trim();
          if (!jwt) continue;
          const c = makeCredentials(jwt);
          if (c.jwt === creds.jwt) throw new HttpError(400, `The ${loaded.rulebook.userTypeLabels[ut] ?? ut} jwt is the Super Admin's: paste that user's own jwt (or leave it empty)`);
          userCreds.set(ut, c);
        }
      }
    } catch (e) {
      forgetAll();
      throw e;
    }
    const apply = body.apply === true;
    const id = newSetterRunId(env.name);
    const state: SetterState = { id, status: 'running', apply, lines: [], outcome: null, controller: new AbortController() };
    setter = state;
    log.info('setter run started', { run: id, env: env.name, apply, roles: bulk ? 1 : Object.keys(roles).length, bulk: bulk ? LEVELS[bulk.step] : undefined, verifyUsers: userCreds.size, ai: body.ai === true });
    void executeSetter(
      {
        environment: env,
        rulebook: loaded?.rulebook ?? null,
        rulebookName: loaded?.name ?? '(none: every slider)',
        roles,
        bulk,
        creds,
        apply,
        headless: body.headed !== true,
        stepDelayMs: body.stepDelaySec !== undefined ? clamp(body.stepDelaySec, 0.5, 10) * 1000 : undefined,
        verify: userCreds.size && loaded ? { creds: userCreds, rulebookSource: { name: loaded.name, data: loaded.data }, waitSec: 5, run: deps.checkAsUsers } : undefined,
        ai: body.ai === true,
        navigation: loaded && body.navigation !== false ? { enabled: true, hints: userHintsFrom(body, loaded.rulebook) } : undefined,
        outputRoot: SETTER_DIR,
        signal: state.controller.signal,
        log: (line) => {
          for (const l of scrub(line).split('\n')) state.lines.push(l);
        },
      },
      id,
    )
      .catch((e: unknown): SetterOutcome => ({ runId: id, outDir: join(SETTER_DIR, id), apply, roles: [], error: scrub((e as Error).message) }))
      .then((outcome) => {
        // Rulebook Apply: leave a hand-off for "Verify in Pages Testing" (columns whose role was saved or already matched).
        const columns = outcome.roles.filter((r) => r.status === 'saved' || r.status === 'no_changes').map((r) => r.userType);
        if (apply && loaded && columns.length) {
          const jwts = new Map<string, string>();
          for (const c of columns) {
            const u = userCreds.get(c);
            if (u) jwts.set(c, u.jwt);
          }
          state.handoffId = createHandoff({ environment: env, rulebookId: loaded.id, columns, roles, sourceRunId: id, jwts });
          log.info('handoff ready for Pages Testing', { run: id, columns: columns.length, jwts: jwts.size, minutes: HANDOFF_MINUTES });
        }
        forgetAll();
        userCreds.clear();
        state.outcome = outcome;
        state.status = outcome.error || outcome.roles.some((r) => r.status === 'failed') ? 'failed' : 'done';
        log.info('setter run finished', { run: id, status: state.status, error: outcome.error });
      });
    return setterState();
  }

  return {
    id: 'setter',
    card: {
      title: 'Permission Setter',
      category: 'Step 1 · Set permissions',
      description: "Sets the role sliders in AMP (Setup → Roles) to match the client's rulebook, as the Super Admin. Preview first, then apply. When it is done, hand the result to Pages Testing in one click.",
      tags: ['Rulebook', 'Super Admin jwt', 'Changes AMP'],
      icon: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
      href: '/setter',
      order: 1,
    },
    pages: { '/setter': SETTER_FILE, '/setter.html': SETTER_FILE },
    isPublic: (method, path) => method === 'GET' && (path === '/api/setter/info' || path === '/api/setter/runs/current'),

    async handle(ctx) {
      const { method, path } = ctx;
      if (!path.startsWith('/api/setter/')) return false;

      if (method === 'GET' && path === '/api/setter/info') {
        // Whether a Gemini key is set for this process (the key itself is never sent to the page).
        return ctx.json(200, { aiKey: aiKeySet(), aiModel: aiModel() });
      }
      if (method === 'GET' && path === '/api/setter/runs/current') return ctx.json(200, { run: setterState(Number(ctx.url.searchParams.get('from') ?? 0)) });
      if (method !== 'POST') return false;

      const body = await ctx.body<SetterBody>();
      const env = environmentFrom(body);
      if (!body.jwt?.trim()) throw new HttpError(400, "Paste the Super Admin's jwt first");
      const creds = makeCredentials(body.jwt);
      const forget = () => forgetSecrets([creds.jwt, creds.csrf]);

      if (path === '/api/setter/check' || path === '/api/setter/plan') {
        try {
          const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'setter-checks.jsonl')));
          const admin = await checkSuperAdmin(gate, creds);
          if (path === '/api/setter/check') {
            log.info('setter token check', { env: env.name, name: admin.identity.userName, admin: admin.isAdmin, modules: admin.modules.length });
            return ctx.json(200, { identity: admin.identity, isAdmin: admin.isAdmin, reason: admin.reason ?? null, modules: admin.modules.length });
          }
          if (!admin.isAdmin) throw new HttpError(400, admin.reason ?? 'not a Super Admin');
          const rb = getRulebook(body.rulebookId ?? '').rulebook;
          const plans = planAll(rb, setterRoles(body, rb), admin.modules);
          let navigation: unknown = null;
          if (body.navigation !== false) {
            const userCreds = new Map<string, Credentials>();
            for (const ut of Object.keys(body.users ?? {})) if (body.users![ut]?.trim()) userCreds.set(ut, makeCredentials(body.users![ut]!));
            try {
              navigation = await prepareNavigation({ gate, creds, rulebook: rb, plans, modules: admin.modules, hints: userHintsFrom(body, rb), userCreds });
            } catch (e) {
              navigation = { nav: [], columnUsers: [], error: scrub((e as Error).message) };
            } finally {
              forgetSecrets([...userCreds.values()].flatMap((c) => [c.jwt, c.csrf]));
            }
          }
          return ctx.json(200, { plans, levels: LEVELS, navigation });
        } finally {
          forget();
        }
      }

      if (path === '/api/setter/runs') return ctx.json(202, { run: await startSetter(body, env, creds, forget) });

      forget();
      throw new HttpError(404, 'Not found');
    },
  };
}

/** Rulebook columns → role names, only for columns the rulebook has. */
function setterRoles(body: SetterBody, rb: Rulebook): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const ut of rb.userTypes) {
    const name = body.roles?.[ut]?.trim();
    if (name) roles[ut] = name.slice(0, 200);
  }
  if (!Object.keys(roles).length) throw new HttpError(400, 'Enter the AMP role to set for at least one rulebook column');
  return roles;
}

/** Column → typed user (email or name), only for the rulebook's columns. */
function userHintsFrom(body: SetterBody, rb: Rulebook): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ut of rb.userTypes) {
    const v = body.userHints?.[ut]?.trim();
    if (v) out[ut] = v.slice(0, 200);
  }
  return out;
}
