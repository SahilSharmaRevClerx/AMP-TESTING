/**
 * P11 T2: AI triage prompt builder + safety tests. Gemini client is always a
 * stub here: no real network, no real key. The key itself is never read.
 */
import { describe, expect, it } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { aiAvailable, aiModelName, buildTriageItems, buildTriagePrompt, sanitizeForPrompt, triage, TRIAGE_BATCH, type TriageItem } from '../src/mcp/ai';
import { toolSchemasOf } from '../src/mcp/classify';
import { forgetSecrets, registerSecret } from '../src/util/mask';
import type { McpResult } from '../src/mcp/types';

const JWT_LIKE = 'eyJhbGciOiJIUzI1NiJ9.planted-secret-payload-0123456789.planted-signature';
const API_KEY_LINE = 'X-Api-Key: hunter2-unregistered-key-value';
const EMAIL = 'someone@example.com';
const TOKEN_URL = 'https://vendor.example/callback?token=abc123&other=1';

function stubClient(calls: string[] = [], reply?: (prompt: string) => string) {
  return {
    models: {
      generateContent: async (args: { contents: { parts: { text: string }[] }[] }) => {
        const prompt = args.contents[0]!.parts[0]!.text;
        calls.push(prompt);
        if (reply) return { text: reply(prompt) };
        const ids = [...prompt.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]!);
        return { text: JSON.stringify(ids.map((id) => ({ id, diagnosis: `About ${id}.`, nextStep: 'Reconnect and rerun.', confidence: 'high' }))) };
      },
    },
  } as unknown as GoogleGenAI;
}

const item = (key: string, bucket: TriageItem['bucket'] = 'BROKEN'): TriageItem => ({
  key, kind: 'server', bucket, name: 'S', serverId: 1, stateWords: 'Fix needed', errorText: 'e', toolNames: ['t'],
});

describe('sanitizeForPrompt (DATA RULE)', () => {
  it('drops a registered jwt, emails, query strings and header key lines, and truncates', () => {
    registerSecret(JWT_LIKE);
    try {
      const out = sanitizeForPrompt(`jwt ${JWT_LIKE} mail ${EMAIL} url ${TOKEN_URL} ${API_KEY_LINE} rejected the key`, 400);
      expect(out).not.toContain(JWT_LIKE);
      expect(out).not.toContain(EMAIL);
      expect(out).not.toContain('token=');
      expect(out).not.toContain('hunter2');
      expect(out).toContain('rejected the key');
    } finally {
      forgetSecrets([JWT_LIKE]);
    }
  });
  it('truncates to max', () => {
    expect(sanitizeForPrompt('x'.repeat(500), 400).length).toBeLessThanOrEqual(401);
  });
});

describe('buildTriagePrompt', () => {
  it('emits the exact contract fields and none of the planted secrets', () => {
    registerSecret(JWT_LIKE);
    try {
      const prompt = buildTriagePrompt([
        {
          key: 'server:5', kind: 'server', bucket: 'BROKEN', name: `Key MCP ${JWT_LIKE}`, serverId: 5,
          stateWords: 'Fix needed — API key rejected', httpStatus: 200,
          errorText: `rejected ${EMAIL} ${TOKEN_URL} ${API_KEY_LINE}`,
          toolNames: ['good_tool'],
          toolFields: [{ name: 'good_tool', fields: [{ name: 'id', type: 'string' }] }],
        },
        {
          key: 'node:WF/4/missing', kind: 'node', bucket: 'BROKEN', name: 'WF / missing', stateWords: 'Fix needed',
          node: { workflow: 'WF Orders', wantedTool: 'missing_tool', serverToolNames: ['good_tool'] },
        },
      ]);
      for (const secret of [JWT_LIKE, EMAIL, 'token=', 'hunter2']) expect(prompt).not.toContain(secret);
      for (const want of ['server:5', 'Key MCP', 'good_tool', 'missing_tool', 'WF Orders', '[{"id"']) expect(prompt).toContain(want);
      expect(prompt).toContain('You cannot call tools');
      expect(prompt).toContain('not enough information');
    } finally {
      forgetSecrets([JWT_LIKE]);
    }
  });
});

describe('buildTriageItems', () => {
  it('keeps non-healthy servers and TOOL_MISSING nodes only', () => {
    const result = {
      order: ['a'], host: 'h', when: 'w', changes: {}, firstRun: {}, notCovered: { webRequestNodes: 0 },
      accounts: {
        a: {
          title: 'a', sub: '',
          servers: [
            { id: 4, name: 'Ok', state: 'OK', bucket: 'HEALTHY', tools: 1, toolNames: ['t'], detail: '', hint: '' },
            { id: 5, name: 'Bad', state: 'KEY_REJECTED', bucket: 'BROKEN', tools: 0, toolNames: [], detail: 'e', hint: '' },
          ],
          nodes: [
            { workflow: 'W', tool: 't', server: 4, state: 'OK', bucket: 'HEALTHY', hint: '' },
            { workflow: 'W', tool: 'm', server: 4, state: 'TOOL_MISSING: m', bucket: 'BROKEN', hint: '' },
            { workflow: 'W', tool: 'x', server: 5, state: 'SERVER_KEY_REJECTED', bucket: 'BROKEN', hint: '' },
          ],
        },
      },
    } as unknown as McpResult;
    const keys = buildTriageItems(result).map((i) => i.key);
    expect(keys).toEqual(['server:5', 'node:W/4/m']);
  });
});

describe('toolSchemasOf', () => {
  it('keeps names and types only, never values', () => {
    const out = toolSchemasOf({ tools: [{ name: 't', inputSchema: { properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] } }, { name: 7 }] });
    expect(out).toEqual([{ name: 't', fields: [{ name: 'id', type: 'string' }, { name: 'n', type: 'integer' }] }]);
  });
});

describe('triage batching, cap and graceful failure (stubbed)', () => {
  it(`batches <= ${TRIAGE_BATCH} per call`, async () => {
    const calls: string[] = [];
    const out = await triage(Array.from({ length: 45 }, (_, i) => item(`server:${i}`)), stubClient(calls));
    expect(calls).toHaveLength(3);
    expect(out.notes).toHaveLength(45);
    expect(out.error).toBeUndefined();
  });
  it('caps at 60 with Fix-needed first', async () => {
    const calls: string[] = [];
    const many = [...Array.from({ length: 65 }, (_, i) => item(`server:b${i}`, 'BROKEN')), ...Array.from({ length: 5 }, (_, i) => item(`server:n${i}`, 'NEEDS_YOU'))];
    const out = await triage(many, stubClient(calls), { cap: 60 });
    expect(calls).toHaveLength(3);
    expect(out.notes).toHaveLength(60);
    expect(out.notes.some((n) => n.id.startsWith('server:n'))).toBe(false);
  });
  it('invalid JSON is skipped, not fatal; total failure becomes one plain message', async () => {
    const bad = stubClient([], () => 'not json at all');
    const out = await triage([item('server:1')], bad);
    expect(out.notes).toEqual([]);
    expect(out.error).toBeTruthy();
    expect(out.error).not.toMatch(/eyJ|sk-/);
  });
  it('one bad batch does not kill the other batches', async () => {
    let n = 0;
    const flaky = stubClient([], (prompt) => {
      n += 1;
      if (n === 1) throw new Error('boom');
      const ids = [...prompt.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ id, diagnosis: 'd.', nextStep: 's.', confidence: 'low' })));
    });
    const out = await triage(Array.from({ length: 25 }, (_, i) => item(`server:${i}`)), flaky);
    expect(out.notes).toHaveLength(5);
    expect(out.error).toBe('boom');
  });
  it('empty items make no client call', async () => {
    const calls: string[] = [];
    expect(await triage([], stubClient(calls))).toEqual({ notes: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('aiAvailable / aiModelName (key never read)', () => {
  it('reports availability as a boolean and names the model', () => {
    expect(typeof aiAvailable()).toBe('boolean');
    expect(typeof aiModelName()).toBe('string');
    expect(aiModelName().length).toBeGreaterThan(0);
  });
  it('false when no key is present', () => {
    if ('GEMINI_API_KEY' in process.env || 'GOOGLE_API_KEY' in process.env) {
      expect(aiAvailable()).toBe(true);
    } else {
      expect(aiAvailable()).toBe(false);
    }
  });
});

describe('triage honours cancel (P11 follow-up)', () => {
  it('an already-aborted signal makes no call and reports cancelled', async () => {
    const calls: string[] = [];
    const ac = new AbortController();
    ac.abort();
    const out = await triage([item('server:1')], stubClient(calls), { signal: ac.signal });
    expect(out.cancelled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('abort between batches stops before the next call and returns the notes so far', async () => {
    const calls: string[] = [];
    const ac = new AbortController();
    const client = stubClient(calls, (prompt) => {
      ac.abort(); // the user presses Cancel while batch 1 is being answered
      const ids = [...prompt.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ id, diagnosis: 'd', nextStep: 'n', confidence: 'high' })));
    });
    const out = await triage(Array.from({ length: TRIAGE_BATCH * 2 }, (_, i) => item(`server:${i}`)), client, { signal: ac.signal });
    expect(out.cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('abort while Gemini is still thinking settles at once instead of waiting for the timeout', async () => {
    const hang = { models: { generateContent: () => new Promise(() => {}) } } as unknown as GoogleGenAI;
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = triage([item('server:1')], hang, { signal: ac.signal, timeoutMs: 60_000 });
    setTimeout(() => ac.abort(), 30);
    const out = await pending;
    expect(out.cancelled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
