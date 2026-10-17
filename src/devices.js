// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one device per Gatus endpoint, identified by its Gatus key
//     (`group_name`, see platformIdOf in src/gatus/client.js):
//       online         input/binary         1 up, 0 down — green / red badge,
//                                           a Yes/No condition in scenes;
//                                           nothing before the first result
//       response_time  duration/integer ms  the last successful check
//       uptime_24h     unknown/unknown %    as computed by Gatus
//       uptime_7d      unknown/unknown %
//   - one "Gatus" device for the instance: endpoints down, in total.
//
// The core has no "percent" category: the uptimes are `unknown/unknown` with
// the percent unit (as gladys-apcupsd does for its load), so their names show.
//
// Published with should_poll: false: the integration reads Gatus on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const ENDPOINT_TYPE = 'endpoint';
export const INSTANCE_TYPE = 'instance';
export const INSTANCE_ID = 'summary';
export const MODEL = 'Gatus';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  ONLINE: 'online',
  RESPONSE_TIME: 'response_time',
  UPTIME_24H: 'uptime_24h',
  UPTIME_7D: 'uptime_7d',
});

export const INSTANCE_KEYS = Object.freeze({
  DOWN: 'down',
  TOTAL: 'total',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.ONLINE]: 'Online',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Response time',
    [FEATURE_KEYS.UPTIME_24H]: 'Uptime 24 h',
    [FEATURE_KEYS.UPTIME_7D]: 'Uptime 7 days',
    [INSTANCE_KEYS.DOWN]: 'Endpoints down',
    [INSTANCE_KEYS.TOTAL]: 'Endpoints in total',
  },
  fr: {
    [FEATURE_KEYS.ONLINE]: 'En ligne',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Temps de réponse',
    [FEATURE_KEYS.UPTIME_24H]: 'Disponibilité 24 h',
    [FEATURE_KEYS.UPTIME_7D]: 'Disponibilité 7 jours',
    [INSTANCE_KEYS.DOWN]: "Points d'accès en panne",
    [INSTANCE_KEYS.TOTAL]: "Points d'accès au total",
  },
  de: {
    [FEATURE_KEYS.ONLINE]: 'Online',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Antwortzeit',
    [FEATURE_KEYS.UPTIME_24H]: 'Verfügbarkeit 24 h',
    [FEATURE_KEYS.UPTIME_7D]: 'Verfügbarkeit 7 Tage',
    [INSTANCE_KEYS.DOWN]: 'Ausgefallene Endpunkte',
    [INSTANCE_KEYS.TOTAL]: 'Endpunkte insgesamt',
  },
  es: {
    [FEATURE_KEYS.ONLINE]: 'En línea',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Tiempo de respuesta',
    [FEATURE_KEYS.UPTIME_24H]: 'Disponibilidad 24 h',
    [FEATURE_KEYS.UPTIME_7D]: 'Disponibilidad 7 días',
    [INSTANCE_KEYS.DOWN]: 'Endpoints caídos',
    [INSTANCE_KEYS.TOTAL]: 'Endpoints en total',
  },
};

// Display bounds (the core never applies them on write). Gatus times a check
// out after 10 s by default; a client timeout can be raised, rarely past 60 s.
export const MAX_RESPONSE_TIME_MS = 60_000;
export const MAX_ENDPOINTS = 10_000;

// The response time changes at every check, the uptimes at every reading:
// published at most every few minutes (src/hub.js), at once with a change of
// state or when the device is added.
export const VOLATILE = new Set([
  FEATURE_KEYS.RESPONSE_TIME,
  FEATURE_KEYS.UPTIME_24H,
  FEATURE_KEYS.UPTIME_7D,
]);

export const endpointIds = (gladys, id) => gladys.externalIds(ENDPOINT_TYPE, id);
export const instanceIds = (gladys) => gladys.externalIds(INSTANCE_TYPE, INSTANCE_ID);

/** The platform id of a device external id, null when it is not an endpoint of ours. */
export function parseEndpointId(gladys, externalId) {
  const prefix = endpointIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const id = externalId.slice(prefix.length);
  return /^[a-z0-9_-]{1,120}$/.test(id) ? id : null;
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const percent = (name, externalId) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.UNKNOWN,
    DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
    {
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      keep_history: true,
      min: 0,
      max: 100,
    },
  );

const counter = (name, externalId) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max: MAX_ENDPOINTS },
  );

/** The discovery payload of an endpoint. */
export function buildEndpointDevice(gladys, endpoint, language = 'en') {
  const ids = endpointIds(gladys, endpoint.id);
  const names = NAMES[language] ?? NAMES.en;
  const params = [{ name: 'GATUS_KEY', value: endpoint.key.slice(0, 255) }];
  if (endpoint.group) {
    params.push({ name: 'GATUS_GROUP', value: endpoint.group });
  }
  return {
    name: endpoint.name,
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params,
    features: [
      sensor(
        names[FEATURE_KEYS.ONLINE],
        ids.feature(FEATURE_KEYS.ONLINE),
        DEVICE_FEATURE_CATEGORIES.INPUT,
        DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        { keep_history: true, min: 0, max: 1 },
      ),
      sensor(
        names[FEATURE_KEYS.RESPONSE_TIME],
        ids.feature(FEATURE_KEYS.RESPONSE_TIME),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        {
          unit: DEVICE_FEATURE_UNITS.MILLISECONDS,
          keep_history: true,
          min: 0,
          max: MAX_RESPONSE_TIME_MS,
        },
      ),
      percent(names[FEATURE_KEYS.UPTIME_24H], ids.feature(FEATURE_KEYS.UPTIME_24H)),
      percent(names[FEATURE_KEYS.UPTIME_7D], ids.feature(FEATURE_KEYS.UPTIME_7D)),
    ],
  };
}

/** The discovery payload of the instance summary. */
export function buildInstanceDevice(gladys, language = 'en') {
  const ids = instanceIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: 'Gatus',
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: Object.values(INSTANCE_KEYS).map((key) => counter(names[key], ids.feature(key))),
  };
}

/** The last successful response time of an endpoint, null when unknown. */
export function responseTimeOf(endpoint) {
  const last = endpoint.results.at(-1);
  return last?.success && last.durationMs !== null ? last.durationMs : null;
}

/**
 * The value of every known feature of an endpoint: `{ key, device_feature_external_id, state }`.
 * @param {object} endpoint normalized endpoint, with `state` ('up'|'down'|'unknown')
 *   and `uptimes` ({ '24h', '7d' }, percent) set by the hub
 */
export function endpointValues(gladys, endpoint) {
  const ids = endpointIds(gladys, endpoint.id);
  const values = [];
  if (endpoint.state !== 'unknown') {
    values.push({ key: FEATURE_KEYS.ONLINE, state: endpoint.state === 'up' ? 1 : 0 });
  }
  const responseTime = responseTimeOf(endpoint);
  if (responseTime !== null) {
    values.push({
      key: FEATURE_KEYS.RESPONSE_TIME,
      state: Math.min(responseTime, MAX_RESPONSE_TIME_MS),
    });
  }
  for (const [key, period] of [
    [FEATURE_KEYS.UPTIME_24H, '24h'],
    [FEATURE_KEYS.UPTIME_7D, '7d'],
  ]) {
    if (Number.isFinite(endpoint.uptimes?.[period])) {
      values.push({ key, state: endpoint.uptimes[period] });
    }
  }
  return values.map(({ key, state }) => ({
    key,
    device_feature_external_id: ids.feature(key),
    state,
  }));
}

/** The values of the instance summary. */
export function instanceValues(gladys, endpoints) {
  const ids = instanceIds(gladys);
  return [
    { key: INSTANCE_KEYS.DOWN, state: endpoints.filter((e) => e.state === 'down').length },
    { key: INSTANCE_KEYS.TOTAL, state: endpoints.length },
  ].map(({ key, state }) => ({ key, device_feature_external_id: ids.feature(key), state }));
}
