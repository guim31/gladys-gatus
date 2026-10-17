// -----------------------------------------------------------------------------
// The Gatus client on the real answer of Gatus in Docker
// (test/fixtures/gatus), its errors, and the configuration parser.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ERROR_KINDS,
  GatusClient,
  GatusError,
  normalizeEndpoint,
  platformIdOf,
} from '../src/gatus/client.js';
import { normalizeConfig, parseServerUrl } from '../src/config.js';
import { failureOf, stateFrom } from '../src/hub.js';
import { BASE, FakeGatus, TOKEN, endpoint, result } from './helpers/fakeGatus.js';

const statuses = await readFile(
  new URL('./fixtures/gatus/statuses-page-size-2.json', import.meta.url),
  'utf8',
);

const clientOn = (response, options = {}) => {
  const requests = [];
  const client = new GatusClient({
    url: BASE,
    request: async (url, init) => {
      requests.push({ url, ...init });
      return response instanceof Error ? Promise.reject(response) : response;
    },
    ...options,
  });
  return { client, requests };
};

test('the real answer of Gatus: keys, groups, results oldest first, nanoseconds', async () => {
  const { client, requests } = clientOn({ status: 200, body: statuses });
  const endpoints = await client.endpoints(2);
  assert.equal(requests[0].url, `${BASE}/api/v1/endpoints/statuses?page=1&pageSize=2`);
  assert.deepEqual(
    endpoints.map((e) => [e.key, e.id, e.name, e.group]),
    [
      ['_broken', '_broken', 'broken', ''],
      ['ext_gladys-push', 'ext_gladys-push', 'gladys-push', 'ext'],
      ['lab_whoami-a', 'lab_whoami-a', 'whoami-a', 'lab'],
      ['lab_whoami-b', 'lab_whoami-b', 'whoami-b', 'lab'],
    ],
  );
  const [broken, external, whoami] = endpoints;
  assert.equal(broken.results.length, 2);
  assert.equal(broken.results.at(-1).success, false);
  assert.match(failureOf(broken), /^\[STATUS\] \(0\) == 200 · Get "http:\/\//);
  assert.equal(external.results.at(-1).durationMs, 12, 'pushed with duration=12ms');
  assert.equal(external.results.at(-1).status, null);
  assert.ok(whoami.results.every((r) => r.success && r.status === 200));
  assert.ok(whoami.results.every((r) => Number.isInteger(r.durationMs) && r.durationMs < 1000));
  assert.ok(whoami.results[0].time < whoami.results[1].time, 'oldest first');
});

test('platform ids: the Gatus key when plain, a hash otherwise, never colliding', () => {
  assert.equal(platformIdOf('core_api'), 'core_api');
  // No group: "_name" is plain too.
  assert.equal(platformIdOf('_nas'), '_nas');
  for (const key of ['broken', 'maison_télé', 'a_b:c', 'x'.repeat(130)]) {
    assert.match(platformIdOf(key), /^h[0-9a-f]{20}$/, key);
  }
  assert.notEqual(platformIdOf('maison_télé'), platformIdOf('maison_tele'));
});

test('normalizeEndpoint skips what cannot be identified, and results without outcome', () => {
  assert.equal(normalizeEndpoint(null), null);
  assert.equal(normalizeEndpoint({ name: 'x' }), null);
  const item = normalizeEndpoint({ key: 'a_b', results: [{ duration: 5 }, result(false), 'x'] });
  assert.equal(item.name, 'a_b');
  assert.equal(item.results.length, 1);
});

test('the state: down after N failures in a row, up at the first success, unchanged in between', () => {
  const ok = { success: true };
  const ko = { success: false };
  assert.equal(stateFrom([], 2), 'unknown');
  assert.equal(stateFrom([], 2, 'down'), 'down');
  assert.equal(stateFrom([ko, ok], 2, 'down'), 'up');
  assert.equal(stateFrom([ok, ko], 2, 'up'), 'up', 'one failure is not enough');
  assert.equal(stateFrom([ok, ko], 2), 'up', 'first read: the success seen');
  assert.equal(stateFrom([ko], 2), 'unknown', 'a new endpoint: not enough results yet');
  assert.equal(stateFrom([ko, ko], 2, 'up'), 'down');
  assert.equal(stateFrom([ko], 1, 'up'), 'down');
  assert.equal(stateFrom([ko, ko, ok, ko, ko], 3, 'down'), 'down');
});

test('the uptimes are plain-text ratios, turned into percent', async () => {
  const { client, requests } = clientOn({ status: 200, body: '0.998611' });
  assert.equal(await client.uptime('lab_whoami-a', '7d'), 99.86);
  assert.equal(requests[0].url, `${BASE}/api/v1/endpoints/lab_whoami-a/uptimes/7d`);
  for (const body of ['', 'abc', '1.5', '<html>']) {
    await assert.rejects(clientOn({ status: 200, body }).client.uptime('a_b', '24h'), {
      kind: ERROR_KINDS.NOT_GATUS,
    });
  }
});

test('basic credentials are sent when configured, never otherwise', async () => {
  const gatus = new FakeGatus({ username: 'gladys', password: ' s3cret ' });
  const right = new GatusClient({
    url: BASE,
    username: 'gladys',
    password: ' s3cret ',
    request: gatus.request,
  });
  assert.equal((await right.endpoints()).length, 4);
  const none = new GatusClient({ url: BASE, request: gatus.request });
  await assert.rejects(none.endpoints(), { kind: ERROR_KINDS.AUTH });
  assert.equal(gatus.requests.at(-1).headers.authorization, undefined);
});

test('errors: unreachable, certificate, credentials, redirect, not Gatus, other', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const selfSigned = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
  });
  const cases = [
    [refused, ERROR_KINDS.UNREACHABLE],
    [selfSigned, ERROR_KINDS.TLS],
    [{ status: 401, body: 'Unauthorized' }, ERROR_KINDS.AUTH],
    [{ status: 302, body: '' }, ERROR_KINDS.REDIRECT],
    [{ status: 404, body: '404 page not found' }, ERROR_KINDS.NOT_GATUS],
    [{ status: 200, body: '<html>Home Assistant</html>' }, ERROR_KINDS.NOT_GATUS],
    [{ status: 200, body: '{"endpoints":[]}' }, ERROR_KINDS.NOT_GATUS],
    [{ status: 500, body: '' }, ERROR_KINDS.HTTP],
  ];
  for (const [response, kind] of cases) {
    const error = await clientOn(response)
      .client.endpoints()
      .catch((err) => err);
    assert.ok(error instanceof GatusError, kind);
    assert.equal(error.kind, kind);
  }
});

test('pushing a result to an external endpoint: bearer token, success or failure with its error', async () => {
  const gatus = new FakeGatus();
  const client = new GatusClient({ url: BASE, request: gatus.request });
  await client.pushExternal('jobs_backups', TOKEN, { success: false, error: 'disk full' });
  const sent = gatus.requests.at(-1);
  assert.equal(sent.method, 'POST');
  assert.equal(
    sent.url,
    `${BASE}/api/v1/endpoints/jobs_backups/external?success=false&error=disk+full`,
  );
  assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(gatus.get('Backups').results.at(-1).errors, ['disk full']);
  await assert.rejects(client.pushExternal('jobs_backups', 'wrong', { success: true }), {
    kind: ERROR_KINDS.TOKEN,
  });
  await assert.rejects(client.pushExternal('core_api', TOKEN, { success: true }), {
    kind: ERROR_KINDS.NOT_FOUND,
  });
});

test('the address: bare host, copied URL, sub-path; credentials in it refused', () => {
  assert.equal(parseServerUrl('192.0.2.10:8080'), 'http://192.0.2.10:8080');
  assert.equal(
    parseServerUrl('https://status.example.org/endpoints/core_api'),
    'https://status.example.org',
  );
  assert.equal(parseServerUrl('http://192.0.2.10/gatus/'), 'http://192.0.2.10/gatus');
  assert.equal(parseServerUrl('http://user:pass@192.0.2.10'), null);
  assert.equal(parseServerUrl('ftp://192.0.2.10'), null);
  assert.equal(parseServerUrl(''), null);
});

test('the configuration: defaults, choices kept within their lists', () => {
  assert.deepEqual(normalizeConfig({}), {
    url: '',
    username: '',
    password: '',
    externalToken: '',
    pollIntervalMs: 60_000,
    failureThreshold: 2,
    language: 'fr',
  });
  const config = normalizeConfig({
    url: ' 192.0.2.10:8080 ',
    username: ' gladys ',
    password: ' keep ',
    external_token: ' tok\n',
    poll_interval: '300',
    failure_threshold: '7',
    language: 'it',
  });
  assert.equal(config.url, 'http://192.0.2.10:8080');
  assert.equal(config.username, 'gladys');
  assert.equal(config.password, ' keep ');
  assert.equal(config.externalToken, 'tok');
  assert.equal(config.pollIntervalMs, 300_000);
  assert.equal(config.failureThreshold, 2);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ url: 'ftp://x' }).url, null);
});

test('the fake Gatus answers like the real one', async () => {
  const real = JSON.parse(statuses)[2];
  const fake = JSON.parse(
    (
      await new FakeGatus({ endpoints: [endpoint('whoami-a', 'lab')] }).request(
        `${BASE}/api/v1/endpoints/statuses?page=1&pageSize=2`,
      )
    ).body,
  )[0];
  assert.deepEqual(
    Object.keys(fake),
    Object.keys(real).filter((key) => key !== 'events'),
  );
  assert.deepEqual(Object.keys(fake.results[0]).sort(), Object.keys(real.results[0]).sort());
  assert.equal(fake.key, real.key);
});
