// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Gatus instance: its address, optional basic credentials (Gatus
// `security.basic`), the token of its external endpoints (to push a result
// from a scene), how often it is read and how many failed checks in a row
// make an endpoint "down".
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['30', '60', '120', '300'];

// Failed checks in a row before an endpoint is down (Gatus `failure-threshold`
// of its own alerts: 3 by default).
export const FAILURE_THRESHOLDS = ['1', '2', '3', '5'];

export const DEFAULT_CONFIG = {
  url: '',
  username: '',
  password: '',
  external_token: '',
  poll_interval: '60',
  failure_threshold: '2',
  language: 'fr',
};

// Pages of the Gatus interface: a URL copied from the browser points at one of
// them, the API lives at the root.
const INTERFACE_PATH = /\/(endpoints|suites|api|health)(\/.*)?$/i;

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`192.0.2.10:8080`), or a URL copied from the browser
 * (`http://192.0.2.10:8080/endpoints/core_api`). HTTP by default for a bare
 * host. A path is kept (Gatus behind a reverse proxy sub-path), the interface
 * pages dropped.
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port][/path]`, null when unusable
 */
export function parseServerUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs: they have their fields.
  if (url.username || url.password) {
    return null;
  }
  const path = url.pathname.replace(INTERFACE_PATH, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https?:\/\//, '');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const choice = (key, options) =>
    options.includes(String(source[key])) ? String(source[key]) : DEFAULT_CONFIG[key];
  const typed = text('url');
  return {
    // Empty: not configured yet; null: typed but not understood.
    url: typed ? parseServerUrl(typed) : '',
    username: text('username'),
    // A password may start or end with a space: kept as typed.
    password: typeof source.password === 'string' ? source.password : '',
    // A pasted token often carries a trailing space or new line.
    externalToken: text('external_token'),
    pollIntervalMs: Number(choice('poll_interval', POLL_INTERVALS)) * 1000,
    failureThreshold: Number(choice('failure_threshold', FAILURE_THRESHOLDS)),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
