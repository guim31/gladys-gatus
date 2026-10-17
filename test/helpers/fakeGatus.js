// -----------------------------------------------------------------------------
// An in-memory Gatus: its endpoints rendered like `/api/v1/endpoints/statuses`
// (checked against the real answers of test/fixtures/gatus in
// test/client.test.js): the newest `pageSize` results, oldest first, the
// duration in nanoseconds; the uptimes as plain text; the external endpoints
// that accept a pushed result with their bearer token; basic credentials when
// set.
// -----------------------------------------------------------------------------

export const BASE = 'http://192.0.2.10:8080';
export const TOKEN = 'external-token-1234';

/** A result: success in 12 ms, unless told otherwise. */
export function result(success = true, fields = {}) {
  return {
    status: success ? 200 : 503,
    hostname: 'service.example',
    duration: 12_000_000,
    conditionResults: [
      { condition: success ? '[STATUS] == 200' : '[STATUS] (503) == 200', success },
    ],
    success,
    timestamp: '2026-10-15T10:00:00Z',
    ...fields,
  };
}

/** Gatus keys: group and name lower case, separators turned into dashes. */
export const keyOf = (group, name) => {
  const sanitize = (text) =>
    text
      .trim()
      .toLowerCase()
      .replace(/[/_,.#+& ]/g, '-');
  return `${sanitize(group ?? '')}_${sanitize(name)}`;
};

export function endpoint(name, group = '', fields = {}) {
  return {
    name,
    group,
    key: keyOf(group, name),
    results: [result(), result()],
    uptimes: { '24h': 1, '7d': 0.998611 },
    external: false,
    ...fields,
  };
}

export class FakeGatus {
  constructor({ endpoints, username = '', password = '' } = {}) {
    this.endpoints = endpoints ?? [
      endpoint('Website', 'core'),
      endpoint('API', 'core'),
      endpoint('NAS', 'home'),
      endpoint('Backups', 'jobs', {
        external: true,
        results: [result(true, { status: undefined })],
      }),
    ];
    this.username = username;
    this.password = password;
    /** 'down': the server does not answer; a number: that HTTP status. */
    this.failure = null;
    this.requests = [];
  }

  get(name) {
    return this.endpoints.find((item) => item.name === name);
  }

  /** Append results to an endpoint: true for a success, false for a failure. */
  push(name, ...outcomes) {
    this.get(name).results.push(...outcomes.map((success) => result(success)));
  }

  render(item, size) {
    const out = { name: item.name };
    if (item.group) {
      out.group = item.group;
    }
    out.key = item.key;
    out.results = item.results.slice(-size).map((raw) => {
      const copy = { ...raw };
      if (copy.status === undefined) {
        delete copy.status;
      }
      return copy;
    });
    return out;
  }

  authorized(headers) {
    if (!this.username) {
      return true;
    }
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    return headers.authorization === expected;
  }

  /** The request seam of src/gatus/client.js. */
  request = async (url, { method = 'GET', headers = {} } = {}) => {
    this.requests.push({ url, method, headers });
    if (this.failure === 'down') {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, body: '' };
    }
    const parsed = new URL(url);
    const path = parsed.pathname;
    const external = path.match(/^\/api\/v1\/endpoints\/([^/]+)\/external$/);
    if (external && method === 'POST') {
      const item = this.endpoints.find(
        (e) => e.key === decodeURIComponent(external[1]) && e.external,
      );
      if (!item) {
        return { status: 404, body: 'not found' };
      }
      if (headers.authorization !== `Bearer ${TOKEN}`) {
        return { status: 401, body: 'invalid token' };
      }
      const success = parsed.searchParams.get('success') === 'true';
      const error = parsed.searchParams.get('error');
      item.results.push({
        duration: 0,
        success,
        timestamp: '2026-10-15T10:05:00Z',
        ...(error ? { errors: [error] } : {}),
      });
      return { status: 200, body: '' };
    }
    if (!this.authorized(headers)) {
      return { status: 401, body: 'Unauthorized' };
    }
    if (path === '/api/v1/endpoints/statuses' && method === 'GET') {
      const size = Number(parsed.searchParams.get('pageSize') ?? 20);
      return {
        status: 200,
        body: JSON.stringify(this.endpoints.map((item) => this.render(item, size))),
      };
    }
    const uptime = path.match(/^\/api\/v1\/endpoints\/([^/]+)\/uptimes\/(24h|7d)$/);
    if (uptime) {
      const item = this.endpoints.find((e) => e.key === decodeURIComponent(uptime[1]));
      if (!item) {
        return { status: 404, body: 'not found' };
      }
      return { status: 200, body: item.uptimes[uptime[2]].toFixed(6) };
    }
    return { status: 404, body: '404 page not found' };
  };
}
