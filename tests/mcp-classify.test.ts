import { describe, expect, it } from 'vitest';
import { bucketRank, classifyNode, classifyServerResponse, quotedStatus, unwrapResponse } from '../src/mcp/classify';

const tools = (...names: string[]) => ({ tools: names.map((name) => ({ name, description: 'd', inputSchema: {}, permission: 'x', readOnly: true })) });

describe('classifyServerResponse (response-shape table, same order as the script)', () => {
  it('NOT_VISIBLE outranks everything when the user cannot see the server', () => {
    const r = classifyServerResponse(200, tools('a'), false);
    expect(r.state).toBe('NOT_VISIBLE');
    expect(r.bucket).toBe('NEEDS_YOU');
    expect(r.toolNames).toEqual([]);
  });
  it.each([500, 401, 302])('API_ERROR on HTTP %i without a usable body', (status) => {
    expect(classifyServerResponse(status, null, true).state).toBe('API_ERROR');
  });
  it('API_ERROR keeps the MAYBE bucket', () => {
    expect(classifyServerResponse(500, null, true).bucket).toBe('MAYBE');
  });
  it.each([
    ['NOT_CONNECTED', 'Could not list tools: this server is not connected to your account', 'NEEDS_YOU'],
    ['KEY_REJECTED', 'The server rejected the key in Headers', 'BROKEN'],
    ['OAUTH_EXPIRED', 'authentication failed (401). Your access token may be expired', 'MAYBE'],
    ['OAUTH_EXPIRED', 'please reconnect this server and retry', 'MAYBE'],
    ['FORBIDDEN', 'access denied (403) for this login', 'BROKEN'],
    ['URL_404', 'got 404 not found from the server URL', 'BROKEN'],
    ['URL_404', 'no configuration for this server', 'BROKEN'],
    ['RATE_LIMITED', 'slow down: 429 from upstream', 'MAYBE'],
    ['DEAD_HOST', 'No such host is known for this tunnel', 'BROKEN'],
    ['DEAD_HOST', 'DNS resolution failed', 'BROKEN'],
    ['REDIRECT', 'URL issues a redirect instead of serving MCP', 'BROKEN'],
    ['HTML_NOT_MCP', 'response was non-JSON (an HTML page)', 'BROKEN'],
    ['UNREACHABLE', 'upstream 503 Service Unavailable', 'BROKEN'],
  ])('%s for error shape "%s" (bucket %s)', (state, error, bucket) => {
    const r = classifyServerResponse(200, { error, tools: [] }, true);
    expect(r.state).toBe(state);
    expect(r.bucket).toBe(bucket);
    expect(r.detail).toBe(error);
  });
  it('KNOWN BLIND SPOT: NOT_CONNECTED outranks host problems for OAuth servers', () => {
    const r = classifyServerResponse(200, { error: 'not connected to your account; also No such host for the tunnel' }, true);
    expect(r.state).toBe('NOT_CONNECTED');
    expect(r.bucket).toBe('NEEDS_YOU');
  });
  it('authRequired flag alone means OAUTH_EXPIRED', () => {
    expect(classifyServerResponse(200, { authRequired: true, tools: [] }, true).state).toBe('OAUTH_EXPIRED');
  });
  it('OK keeps sorted tool names and an empty hint', () => {
    const r = classifyServerResponse(200, tools('b', 'a'), true);
    expect(r.state).toBe('OK');
    expect(r.bucket).toBe('HEALTHY');
    expect(r.toolNames).toEqual(['b', 'a']);
    expect(r.hint).toBe('');
    expect(r.detail).toBe('');
  });
  it('NO_TOOLS when reachable but zero tools', () => {
    const r = classifyServerResponse(200, tools(), true);
    expect(r.state).toBe('NO_TOOLS');
    expect(r.bucket).toBe('BROKEN');
  });
  it('unwraps {data}, {result} envelopes like the script', () => {
    expect(classifyServerResponse(200, { data: tools('a') }, true).state).toBe('OK');
    expect(classifyServerResponse(200, { result: { error: 'No such host' } }, true).state).toBe('DEAD_HOST');
  });
  it('keeps only string tool names', () => {
    const r = classifyServerResponse(200, { tools: [{ name: 'a' }, { name: 7 }, {}, { name: null }] }, true);
    expect(r.toolNames).toEqual(['a']);
  });
  it('unwrapResponse leaves tools/error shapes alone', () => {
    const j = { tools: [] };
    expect(unwrapResponse(j)).toBe(j);
  });
});

describe('classifyNode', () => {
  const healthy = { state: 'OK' as const, bucket: 'HEALTHY' as const, hint: '', toolNames: ['search_threads', 'get_ticket'] };
  it('OK when the wanted tool exists', () => {
    const n = classifyNode({ workflow: 'W', tool: 'search_threads', serverId: 4 }, healthy);
    expect(n).toMatchObject({ server: 4, state: 'OK', bucket: 'HEALTHY' });
  });
  it('TOOL_MISSING names the absent tool and stays BROKEN', () => {
    const n = classifyNode({ workflow: 'W', tool: 'nope', toolNames: ['also_nope'], serverId: 4 }, healthy);
    expect(n.state).toBe('TOOL_MISSING: nope,also_nope');
    expect(n.bucket).toBe('BROKEN');
  });
  it('unhealthy servers propagate SERVER_<state> with the server bucket and hint', () => {
    const n = classifyNode(
      { workflow: 'W', tool: 't', serverId: 9 },
      { state: 'DEAD_HOST', bucket: 'BROKEN', hint: 're-point it', toolNames: [] },
    );
    expect(n).toMatchObject({ server: 9, state: 'SERVER_DEAD_HOST', bucket: 'BROKEN', hint: 're-point it' });
  });
  it('unknown servers are NOT_VISIBLE, never broken', () => {
    const n = classifyNode({ workflow: 'W', tool: 't', serverId: 180 }, undefined);
    expect(n).toMatchObject({ state: 'SERVER_NOT_VISIBLE', bucket: 'NEEDS_YOU' });
  });
  it.each([undefined, Number.NaN])('NOT_CHECKED for absent/non-numeric id %s', (serverId) => {
    const n = classifyNode({ workflow: 'W', tool: 't', serverId: serverId as undefined }, healthy);
    expect(n).toMatchObject({ state: 'NOT_CHECKED', bucket: 'NEEDS_YOU' });
  });
  it('NOT_CHECKED for text ids and non-Literal expressions, never guessed', () => {
    expect(classifyNode({ workflow: 'W', tool: 't', serverId: 'asana' }, healthy).state).toBe('NOT_CHECKED');
    expect(classifyNode({ workflow: 'W', tool: 't', serverId: 4, nonLiteral: true }, healthy).state).toBe('NOT_CHECKED');
  });
});

describe('bucketRank (combine order HEALTHY, BROKEN, MAYBE, NEEDS_YOU)', () => {
  it('orders best first', () => {
    expect([bucketRank('NEEDS_YOU'), bucketRank('MAYBE'), bucketRank('BROKEN'), bucketRank('HEALTHY')]).toEqual([3, 2, 1, 0]);
  });
});

describe('classifier hardening: structured signals first, certainty, unrecognised errors', () => {
  const run = (error: string, extra: Record<string, unknown> = {}) => classifyServerResponse(200, { error, tools: [], ...extra }, true);

  it("real AMP 403 that mentions 'SignedHeaders' and 'Reconnect' is a permissions problem, not a rejected key", () => {
    const r = run('Could not list tools from the MCP server: access denied (403). Your account is missing the required permissions/scopes. Reconnect with broader permissions or contact an administrator. Server said: {"message":"Authorization header requires \'SignedHeaders\' parameter."}');
    expect(r.state).toBe('FORBIDDEN');
    expect(r.bucket).toBe('BROKEN');
    expect(r.certainty).toBe('high'); // exact AMP template (MCPPromptRunner.cs:1068), not a quoted code
  });
  it('a quoted 404 beats the word "expired" on the error page', () => {
    expect(run('Server returned 404 Not Found: this link has expired').state).toBe('URL_404');
  });
  it('a number that is not in a status shape (a port) does not decide the cause', () => {
    expect(quotedStatus('connect failed to tunnel.example:4040')).toBeNull();
    expect(run('something odd happened on port 4040').state).toBe('UNKNOWN_ERROR');
  });
  it('the word "Headers" alone is only a low-certainty guess', () => {
    const r = run('Headers were malformed somewhere');
    expect(r.state).toBe('KEY_REJECTED');
    expect(r.certainty).toBe('low');
  });
  it('an error no rule knows is UNKNOWN_ERROR, Fix needed, low certainty, with its text kept', () => {
    const r = run('Quantum flux capacitor misaligned');
    expect(r.state).toBe('UNKNOWN_ERROR');
    expect(r.bucket).toBe('BROKEN');
    expect(r.certainty).toBe('low');
    expect(r.detail).toBe('Quantum flux capacitor misaligned');
  });
  it.each([
    ['not connected to your account', 'high'],
    // Vendor/BCL wording (absent from AMP's source): never "high", even when exact.
    ['The server rejected the key in Headers', 'medium'],
    ['No such host is known for this tunnel', 'medium'],
    ['upstream 503 Service Unavailable', 'medium'],
    ['DNS resolution failed', 'medium'],
  ])('certainty for "%s" is %s', (error, want) => {
    expect(run(error).certainty).toBe(want);
  });
  it('the authRequired flag is high certainty; OK and NO_TOOLS are high; visibility and AMP call failures are high', () => {
    expect(classifyServerResponse(200, { authRequired: true, tools: [] }, true).certainty).toBe('high');
    expect(classifyServerResponse(200, tools('a'), true).certainty).toBe('high');
    expect(classifyServerResponse(200, tools(), true).certainty).toBe('high');
    expect(classifyServerResponse(200, tools('a'), false).certainty).toBe('high');
    expect(classifyServerResponse(500, null, true).certainty).toBe('high');
  });
  it.each([
    ['access denied (403)', 403],
    ['HTTP 404 from upstream', 404],
    ['HTTP/1.1 502 from proxy', 502],
    ['status code 429', 429],
    ['status: 500', 500],
    ['503 Service Unavailable', 503],
    ['request id 401234 failed', null],
  ])('quotedStatus("%s") = %s', (text, want) => {
    expect(quotedStatus(text)).toBe(want);
  });
});
