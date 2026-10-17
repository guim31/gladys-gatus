// -----------------------------------------------------------------------------
// Gatus client: the REST API of the Gatus server (Apache-2.0,
// https://github.com/TwiN/gatus), checked against Gatus 5.x in Docker
// (test/fixtures/gatus):
//
//   GET  /api/v1/endpoints/statuses?page=1&pageSize=N
//        every endpoint (`key`, `name`, `group`) with its N newest results
//        (`success`, `status`, `duration` in nanoseconds, `errors`,
//        `conditionResults`, `timestamp`), oldest first
//   GET  /api/v1/endpoints/{key}/uptimes/{24h|7d}
//        the uptime, as plain text: a ratio from 0 to 1 ("0.998611")
//   POST /api/v1/endpoints/{key}/external?success=…&error=…
//        the result of an external endpoint, `Authorization: Bearer <token>`
//
// Basic credentials (Gatus `security.basic`) are sent when configured. Gatus
// behind OIDC answers 401 to the API: not supported (no browser here).
//
// Redirects are not followed: the credentials would be sent to wherever the
// address points (an http:// address redirected to https:// is reported).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify
  AUTH: 'auth', // the API asks for credentials (wrong, missing, or OIDC)
  NOT_GATUS: 'not_gatus', // something answers, not the Gatus API
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  NOT_FOUND: 'not_found', // the endpoint does not exist (or is not external)
  TOKEN: 'token', // the external endpoint refused the token
  HTTP: 'http', // any other HTTP error
});

export class GatusError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'GatusError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Gatus caps pageSize at 100.
export const MAX_PAGE_SIZE = 100;

/**
 * The one function that talks to the network (fetch). The client takes it as
 * a parameter: the tests replace it with an in-memory Gatus
 * (test/helpers/fakeGatus.js).
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function httpRequest(url, { method = 'GET', headers = {}, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) {
    throw new Error('Response too large');
  }
  return { status: response.status, body };
}

/**
 * The platform id of an endpoint: its Gatus key when it is a plain identifier
 * (`group_name`, lower case, the separators turned into dashes), a hash of it
 * otherwise (accents, colons). A plain key always holds an underscore, a hash
 * never: they cannot collide.
 */
export function platformIdOf(key) {
  return /^[a-z0-9_-]{1,120}$/.test(key) && key.includes('_')
    ? key
    : `h${createHash('sha1').update(key).digest('hex').slice(0, 20)}`;
}

const dateOf = (value) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

const clean = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** One result of an endpoint, normalized; null when it has no outcome. */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.success !== 'boolean') {
    return null;
  }
  const failed = (Array.isArray(raw.conditionResults) ? raw.conditionResults : [])
    .filter((condition) => condition && condition.success === false)
    .map((condition) => clean(condition.condition, 200))
    .filter(Boolean);
  return {
    success: raw.success,
    status: Number.isInteger(raw.status) ? raw.status : null,
    // Nanoseconds in the API.
    durationMs: Number.isFinite(raw.duration) ? Math.round(Math.max(0, raw.duration) / 1e6) : null,
    time: dateOf(raw.timestamp),
    errors: (Array.isArray(raw.errors) ? raw.errors : []).map((e) => clean(e, 300)).filter(Boolean),
    failed,
  };
}

/**
 * One endpoint of the API, normalized; null when it cannot be identified.
 * @returns {object|null} { key, id, name, group, results } — results oldest first
 */
export function normalizeEndpoint(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key.trim()) {
    return null;
  }
  const key = raw.key.trim();
  const results = (Array.isArray(raw.results) ? raw.results : [])
    .map(normalizeResult)
    .filter(Boolean);
  return {
    key,
    id: platformIdOf(key),
    name: clean(raw.name, 255) || key,
    group: clean(raw.group, 255),
    results,
  };
}

export class GatusClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, `http(s)://host[:port][/path]`
   * @param {string} [options.username] basic credentials, if Gatus asks for them
   * @param {string} [options.password]
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, username = '', password = '', request = httpRequest, timeoutMs = 10_000 }) {
    this.url = url;
    this.authorization = username
      ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      : null;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  async call(path, { method = 'GET', headers = {} } = {}) {
    try {
      return await this.request(`${this.url}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(this.authorization ? { authorization: this.authorization } : {}),
          ...headers,
        },
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const code = err.cause?.code ?? err.code;
      if (TLS_CODES.has(code)) {
        throw new GatusError(ERROR_KINDS.TLS, `Certificate refused (${code})`);
      }
      throw new GatusError(ERROR_KINDS.UNREACHABLE, code ?? err.name ?? err.message);
    }
  }

  check({ status }) {
    if (status === 401 || status === 403) {
      throw new GatusError(ERROR_KINDS.AUTH, `Credentials refused (HTTP ${status})`, { status });
    }
    if (status >= 300 && status < 400) {
      throw new GatusError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if (status === 404) {
      throw new GatusError(ERROR_KINDS.NOT_GATUS, 'No Gatus API at this address (HTTP 404)', {
        status,
      });
    }
    if (status < 200 || status >= 300) {
      throw new GatusError(ERROR_KINDS.HTTP, `Unexpected answer (HTTP ${status})`, { status });
    }
  }

  /**
   * Every endpoint with its newest results.
   * @param {number} results how many results per endpoint (1 to 100)
   * @returns {Promise<object[]>}
   * @throws {GatusError}
   */
  async endpoints(results = 1) {
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(results)));
    const response = await this.call(`/api/v1/endpoints/statuses?page=1&pageSize=${size}`);
    this.check(response);
    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      data = null;
    }
    if (!Array.isArray(data)) {
      throw new GatusError(ERROR_KINDS.NOT_GATUS, 'The answer is not a Gatus endpoint list');
    }
    return data.map(normalizeEndpoint).filter(Boolean);
  }

  /**
   * The uptime of an endpoint over a period, in percent.
   * @param {string} key Gatus key of the endpoint
   * @param {'24h'|'7d'} period
   * @returns {Promise<number>}
   * @throws {GatusError}
   */
  async uptime(key, period) {
    const response = await this.call(
      `/api/v1/endpoints/${encodeURIComponent(key)}/uptimes/${period}`,
      { headers: { accept: 'text/plain' } },
    );
    this.check(response);
    const ratio = Number(response.body.trim());
    if (!response.body.trim() || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new GatusError(ERROR_KINDS.NOT_GATUS, 'The answer is not an uptime');
    }
    return Math.round(ratio * 10_000) / 100;
  }

  /**
   * Push the result of an external endpoint (Gatus `external-endpoints`).
   * @param {string} key Gatus key of the external endpoint
   * @param {string} token its bearer token
   * @param {{ success: boolean, error?: string }} result
   * @throws {GatusError}
   */
  async pushExternal(key, token, { success, error = '' }) {
    const query = new URLSearchParams({ success: String(success) });
    if (!success && error) {
      query.set('error', error.slice(0, 500));
    }
    const response = await this.call(
      `/api/v1/endpoints/${encodeURIComponent(key)}/external?${query}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 401 || response.status === 403) {
      throw new GatusError(ERROR_KINDS.TOKEN, `Token refused (HTTP ${response.status})`, {
        status: response.status,
      });
    }
    if (response.status === 404) {
      throw new GatusError(ERROR_KINDS.NOT_FOUND, 'External endpoint not found (HTTP 404)', {
        status: 404,
      });
    }
    this.check(response);
  }
}
