import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cleanError, MockGSC } from '../src/gsc.ts';

test('cleanError names the two 403s apart, because their remedies are different', () => {
  const noQuota = cleanError({
    response: { status: 403, data: { error: { message: 'Your application is authenticating by using local Application Default Credentials. The searchconsole.googleapis.com API requires a quota project.' } } },
  });
  assert.match(noQuota, /GOOGLE_QUOTA_PROJECT/, 'says which variable to set');

  const noAccess = cleanError({ response: { status: 403, data: { error: { message: 'User does not have sufficient permission for site.' } } } });
  assert.match(noAccess, /Users and permissions/, 'points at the Search Console screen that fixes it');
  assert.doesNotMatch(noAccess, /GOOGLE_QUOTA_PROJECT/, 'does not send someone to the wrong fix');

  // Three, now. A token that was never GRANTED the Search Console scope gets the same 403 as one
  // whose account lacks ACCESS, and the remedies share nothing: reconnect and tick a box, versus
  // be added to the property. Owning the property does not help the first one at all, so sending
  // someone to Users and permissions is an afternoon spent on a screen that is already correct.
  const noScope = cleanError({
    response: { status: 403, data: { error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } } },
  });
  assert.match(noScope, /consent screen/, 'points at where a scope is actually granted');
  assert.doesNotMatch(noScope, /Users and permissions/, 'and not at the screen that cannot fix it');
  assert.doesNotMatch(noScope, /GOOGLE_QUOTA_PROJECT/);
});

test('cleanError explains a 401 as a revoked token rather than a wrong password', () => {
  const m = cleanError({ response: { status: 401, data: { error: { message: 'invalid_grant' } } } });
  assert.match(m, /refresh token/);
  assert.match(m, /invalid_grant/, 'keeps the original text, which is what a search engine matches on');
});

test('cleanError digs the useful sentence out from under the generic axios message', () => {
  const m = cleanError({ message: 'Request failed with status code 429', response: { status: 429, data: { error: { message: 'Quota exceeded for quota metric' } } } });
  assert.match(m, /Quota exceeded for quota metric/);
  assert.match(m, /1200 queries per minute/, 'says what the limit actually is');
});

test('cleanError survives shapes it has never seen', () => {
  assert.equal(typeof cleanError(new Error('plain')), 'string');
  assert.equal(typeof cleanError('a bare string'), 'string');
  assert.equal(typeof cleanError(null), 'string');
  assert.equal(typeof cleanError(undefined), 'string');
});

test('the mock is deterministic, so the suite cannot flake on it', async () => {
  const a = await new MockGSC().searchAnalytics({ siteUrl: 's', startDate: '2026-01-01', endDate: '2026-01-28', dimensions: ['query'], rowLimit: 100, searchType: 'web', filters: [] });
  const b = await new MockGSC().searchAnalytics({ siteUrl: 's', startDate: '2026-01-01', endDate: '2026-01-28', dimensions: ['query'], rowLimit: 100, searchType: 'web', filters: [] });
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test('the mock honours rowLimit and filters', async () => {
  const gsc = new MockGSC();
  const capped = await gsc.searchAnalytics({ siteUrl: 's', startDate: '2026-01-01', endDate: '2026-01-28', dimensions: ['query'], rowLimit: 2, searchType: 'web', filters: [] });
  assert.equal(capped.length, 2);

  const filtered = await gsc.searchAnalytics({ siteUrl: 's', startDate: '2026-01-01', endDate: '2026-01-28', dimensions: ['query'], rowLimit: 100, searchType: 'web', filters: [{ dimension: 'query', operator: 'contains', expression: 'ocene' }] });
  assert.ok(filtered.length > 0 && filtered.length < capped.length + 5);
  for (const r of filtered) assert.match(r.keys.join(' '), /ocene/);
});

test('mock CTR is consistent with its own clicks and impressions', async () => {
  for (const r of await new MockGSC().searchAnalytics({ siteUrl: 's', startDate: '2026-01-01', endDate: '2026-01-28', dimensions: ['query'], rowLimit: 100, searchType: 'web', filters: [] })) {
    assert.ok(Math.abs(r.ctr - r.clicks / r.impressions) < 1e-9, 'a mock whose arithmetic disagrees with itself would hide a real formatting bug');
  }
});
