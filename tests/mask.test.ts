import { describe, expect, it } from 'vitest';
import { cleanJwt, forgetSecrets, maskToken, registerSecret, scrub } from '../src/core/util/mask';
import { makeCredentials } from '../src/core/credentials';

describe('cleanJwt', () => {
  it.each([
    ['eyJabc.def.ghi', 'eyJabc.def.ghi'],
    ['  eyJabc.def.ghi  ', 'eyJabc.def.ghi'],
    ['"eyJabc.def.ghi"', 'eyJabc.def.ghi'],
    ['jwt=eyJabc.def.ghi', 'eyJabc.def.ghi'],
    ['jwt=eyJabc.def.ghi;', 'eyJabc.def.ghi'],
    ['X-CSRF-Token=123; jwt=eyJabc.def.ghi; other=1', 'eyJabc.def.ghi'],
  ])('%s -> %s', (input, out) => expect(cleanJwt(input)).toBe(out));
});

describe('secret masking', () => {
  it('masks registered secrets and stops once forgotten', () => {
    const s = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    registerSecret(s);
    expect(scrub(`cookie jwt=${s}`)).toBe(`cookie jwt=${maskToken(s)}`);
    forgetSecrets([s]);
    expect(scrub(s)).toBe(s);
  });

  it('makeCredentials cleans the jwt and generates a CSRF value', () => {
    const c = makeCredentials('jwt=eyJabc.def.ghi;');
    expect(c.jwt).toBe('eyJabc.def.ghi');
    expect(c.csrf).toMatch(/^[0-9a-f-]{36}$/);
    forgetSecrets([c.jwt, c.csrf]);
  });
});
