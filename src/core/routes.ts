import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getHandoff } from './handoff';
import { environmentFrom, HttpError, KEY_RE } from './http';
import type { TestModule } from './module';
import { OUTPUT_DIR, RULEBOOK_DIR } from './paths';
import { parseRulebook, rulebookSummary } from './rulebook/parse';
import { addRulebook, findRulebook } from './rulebooks';
import { RequestGate } from './safety/gate';
import { duplicateIdentities, validateToken } from './sessions/validate';
import type { Environment, Rulebook } from './types';
import { credsFrom, jwtOf, type UserInput } from './users';
import { AuditLog } from './util/audit';
import { createLogger } from './util/logger';
import { forgetSecrets } from './util/mask';

const log = createLogger('server');

/**
 * Routes every module's page uses: the saved rulebooks, reading one, checking user jwts, and
 * picking up a hand-off. Not a testing module itself (no catalog card).
 */
export const sharedRoutes: TestModule = {
  id: 'shared',
  isPublic: (method, path) => method === 'GET' && path === '/api/rulebooks',
  isRoutine: (method, path) => method === 'GET' && path === '/api/rulebooks',

  async handle(ctx) {
    const { method, path } = ctx;

    if (method === 'GET' && path === '/api/rulebooks') {
      const files = existsSync(RULEBOOK_DIR) ? readdirSync(RULEBOOK_DIR).filter((f) => /\.(csv|xlsx)$/i.test(f)) : [];
      return ctx.json(200, { files });
    }

    const ho = /^\/api\/handoff\/([\w-]+)$/.exec(path);
    if (method === 'GET' && ho) {
      const h = getHandoff(ho[1]);
      if (!h) throw new HttpError(404, 'This hand-off from the Permission Setter has expired. Start the page test from the catalog.');
      const loaded = findRulebook(h.rulebookId);
      if (!loaded) throw new HttpError(404, 'The rulebook from the Permission Setter is no longer loaded (was the server restarted?).');
      return ctx.json(200, {
        environment: h.environment,
        rulebook: { id: loaded.id, name: loaded.name, summary: rulebookSummary(loaded.rulebook) },
        columns: h.columns,
        roles: h.roles,
        // Which columns have a jwt kept in memory; never the jwt itself.
        jwtFor: [...h.jwts.keys()],
        setterRunId: h.sourceRunId,
        expiresAt: new Date(h.expiresAt).toISOString(),
      });
    }

    if (method === 'POST' && path === '/api/rulebooks/parse') {
      const body = await ctx.body<{ file?: string; name?: string; contentBase64?: string }>();
      let name: string;
      let data: Buffer;
      if (body.file) {
        const file = resolve(RULEBOOK_DIR, body.file);
        if (!file.startsWith(RULEBOOK_DIR + sep) || !existsSync(file)) throw new HttpError(400, 'Unknown rulebook file');
        name = body.file;
        data = readFileSync(file);
      } else if (body.name && body.contentBase64) {
        name = body.name.replace(/[^\w.\- ]/g, '_');
        data = Buffer.from(body.contentBase64, 'base64');
      } else throw new HttpError(400, 'Choose a rulebook file');
      let rulebook: Rulebook;
      try {
        rulebook = await parseRulebook(name, data);
      } catch (e) {
        throw new HttpError(400, `Could not read rulebook: ${(e as Error).message}`);
      }
      const bad = rulebook.userTypes.filter((ut) => !KEY_RE.test(ut));
      if (bad.length) throw new HttpError(400, `User-type column names are too long (max 40 characters): ${bad.map((b) => rulebook.userTypeLabels[b] ?? b).join(', ')}`);
      const loaded = addRulebook(name, data, rulebook);
      const summary = rulebookSummary(rulebook);
      log.info('rulebook loaded', { name, source: body.file ? 'saved' : 'upload', bytes: data.length, pages: summary.pages, userTypes: summary.userTypes });
      return ctx.json(200, { id: loaded.id, name, summary });
    }

    if (method === 'POST' && path === '/api/tokens/check') {
      const body = await ctx.body<{ environment?: Environment; users?: UserInput[] }>();
      const env = environmentFrom(body);
      const users = (body.users ?? []).filter((u) => u.key && KEY_RE.test(u.key) && jwtOf(u));
      if (!users.length) throw new HttpError(400, 'Paste a jwt for at least one user first');
      const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'token-checks.jsonl')));
      const results = [];
      for (const u of users) {
        const creds = credsFrom([u], [u.key]);
        const c = creds.get(u.key)!;
        const identity = await validateToken(gate, u.key, c).finally(() => forgetSecrets([c.jwt, c.csrf]));
        results.push({ key: u.key, identity });
        if (identity.valid) log.info('token check ok', { env: env.name, user: u.key, name: identity.userName, persona: identity.persona, siteAdmin: identity.isSiteAdmin, company: identity.companyName, org: identity.organizationName });
        else log.warn('token check failed', { env: env.name, user: u.key, reason: identity.reason });
      }
      // Two rows logged in as the same person: the later row is not usable.
      const labelOf = (key: string) => users.find((x) => x.key === key)?.label || key;
      for (const [dup, first] of duplicateIdentities(results.map((x) => x.identity))) {
        const row = results.find((x) => x.key === dup)!;
        const reason = `same person as ${labelOf(first)} (${row.identity.userName}): paste a jwt from a ${labelOf(dup)} user's own session`;
        row.identity = { ...row.identity, valid: false, reason };
        log.warn('token check: same user on two rows', { env: env.name, user: dup, sameAs: first });
      }
      return ctx.json(200, { results });
    }

    return false;
  },
};
