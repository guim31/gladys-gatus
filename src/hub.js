// -----------------------------------------------------------------------------
// The Gatus hub: the instance read on a timer of the container (the interval
// chosen in the configuration); the states of the added devices published
// when they change, the scene events fired on transitions, and the views the
// widget and the scene actions read. (Adapted from guim31/gladys-healthchecks.)
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every endpoint, added to Gladys or not — "an endpoint
// goes down" spares the user one scene per device.
//
// Down or up: the newest results of Gatus, the `failure_threshold` newest ones
// all failed for "down" (as the `failure-threshold` of Gatus alerts), the last
// one successful for "up"; in between, the state stays. The last state of each
// endpoint is kept in /data (src/store.js): an endpoint that went down while
// the integration or Gladys restarted is still announced, once.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  VOLATILE,
  buildEndpointDevice,
  buildInstanceDevice,
  endpointIds,
  endpointValues,
  instanceIds,
  instanceValues,
  parseEndpointId,
} from './devices.js';
import { ERROR_KINDS, GatusClient, GatusError } from './gatus/client.js';
import { hostOf, normalizeConfig } from './config.js';
import { ProblemLog } from './problems.js';
import { ACTION_TEXT, CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'gatus-hub' });

export const WIDGET_KEY = 'gatus';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  DOWN: 'endpoint_down',
  UP: 'endpoint_up',
});

export const HUB_TIMINGS = {
  // The response time changes at every check: published at most this often
  // per endpoint (a change of state publishes it at once), so a hundred
  // endpoints read every 30 seconds stay far below the 300 states per minute
  // Gladys accepts.
  volatileEveryMs: 5 * 60_000,
  // The uptimes (one request per endpoint and period) are read this often:
  // Gatus computes them per hour, a closer reading would only load it.
  uptimeEveryMs: 5 * 60_000,
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // A scene action reads Gatus again when the last read is older.
  freshMs: 15_000,
  // Gatus caches its statuses answer for 10 seconds: a result pushed to an
  // external endpoint is read this long after the push, not at once.
  afterPushMs: 11_000,
  // An endpoint missing from the answers of Gatus is forgotten after this.
  forgetMs: 24 * 3600_000,
};

const MAX_TRANSPORTS_PER_REQUEST = 100;
const UPTIME_CONCURRENCY = 4;
export const UPTIME_PERIODS = ['24h', '7d'];

/**
 * The state of an endpoint from its newest results (oldest first).
 * @param {object[]} results
 * @param {number} threshold failed results in a row for "down"
 * @param {string} [previous] the state before this read
 * @returns {'up'|'down'|'unknown'}
 */
export function stateFrom(results, threshold, previous) {
  if (results.length === 0) {
    return previous ?? 'unknown';
  }
  if (results.at(-1).success) {
    return 'up';
  }
  const newest = results.slice(-threshold);
  if (newest.length >= threshold && newest.every((result) => !result.success)) {
    return 'down';
  }
  // A failure, not yet enough of them: the state stays.
  return previous ?? (results.some((result) => result.success) ? 'up' : 'unknown');
}

/** When the failures at the end of the results started, null when unknown. */
export function failingSince(results) {
  let since = null;
  for (let i = results.length - 1; i >= 0 && !results[i].success; i -= 1) {
    since = results[i].time ?? since;
  }
  return since;
}

/** What failed in the last result: the failed conditions, else the errors. */
export function failureOf(endpoint) {
  const last = endpoint.results.at(-1);
  if (!last || last.success) {
    return '';
  }
  return [...last.failed, ...last.errors].join(' · ').slice(0, 300);
}

export class GatusHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/gatus/client.js)
   * @param {boolean} [options.timers] the reading timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    // Defaults until start(): a handler reached after a failed start still
    // answers with a readable message.
    this.config = normalizeConfig({});
    this.client = null;
    this.signature = null;
    /** @type {Map<string, object>} endpoints of the last read, by platform id */
    this.endpoints = new Map();
    /** @type {Map<string, object>} uptimes in percent, by platform id */
    this.uptimes = new Map();
    this.uptimesAt = 0;
    this.readAt = 0;
    this.error = null;
    this.polling = null;
    /** When the volatile features of an endpoint were last published, by id. */
    this.volatileAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = { endpoints: {} };
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    const endpoints = saved.endpoints && typeof saved.endpoints === 'object' ? saved.endpoints : {};
    this.saved = { endpoints };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.volatileAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.signature !== null && this.config.language !== config.language;
    this.config = config;
    const signature = JSON.stringify([config.url, config.username, config.password]);
    if (signature !== this.signature) {
      if (this.signature !== null && JSON.parse(this.signature)[0] !== config.url) {
        // Another Gatus: the states saved for the previous one mean nothing.
        this.saved.endpoints = {};
        this.store.save(this.saved);
      }
      this.signature = signature;
      this.client = config.url
        ? new GatusClient({
            url: config.url,
            username: config.username,
            password: config.password,
            request: this.request,
          })
        : null;
      this.endpoints = new Map();
      this.uptimes = new Map();
      this.uptimesAt = 0;
      this.readAt = 0;
      this.error = null;
      this.polling = null;
    }
    if (languageChanged) {
      // New names for the Discovery tab.
      this.discovered = null;
    }
    try {
      if (this.client) {
        await this.pollNow({ publish: true });
      } else {
        await this.afterChanges(true, { publish: true });
      }
    } finally {
      this.schedulePoll();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  /** The next read by the timer, after `delayMs` (the refresh interval by default). */
  schedulePoll(delayMs = this.config.pollIntervalMs) {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.problems.recover('poll', 'Reading Gatus works again');
      } catch (err) {
        this.problems.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, delayMs);
  }

  // --- Reading Gatus -----------------------------------------------------------

  /** Read the instance now and publish what changed. */
  async pollNow({ publish = false } = {}) {
    const changed = await this.poll();
    await this.afterChanges(changed, { publish });
  }

  /** Read again when the last read is older than `freshMs` (scene actions). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /**
   * Read the instance and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!this.polling) {
      const polling = this.read(this.client).finally(() => {
        // A read of a previous client must not drop the promise of the current one.
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(client) {
    let endpoints;
    try {
      endpoints = await client.endpoints(this.config.failureThreshold);
    } catch (err) {
      if (!(err instanceof GatusError)) {
        throw err;
      }
      return client === this.client && this.applyFailure(err);
    }
    if (client !== this.client) {
      return false;
    }
    const uptimesChanged = await this.readUptimes(client, endpoints);
    // Checked once more after the last await: applySuccess changes the state
    // before its first await, so a read of a previous client never lands.
    if (client !== this.client) {
      return false;
    }
    return (await this.applySuccess(endpoints)) || uptimesChanged;
  }

  /** The uptimes of every endpoint, every `uptimeEveryMs`. */
  async readUptimes(client, endpoints) {
    if (this.uptimesAt !== 0 && this.now() - this.uptimesAt < this.timings.uptimeEveryMs) {
      return false;
    }
    this.uptimesAt = this.now();
    const queue = endpoints.flatMap((endpoint) =>
      UPTIME_PERIODS.map((period) => ({ endpoint, period })),
    );
    const next = new Map();
    const failures = [];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { endpoint, period } = job;
        try {
          const value = await client.uptime(endpoint.key, period);
          next.set(endpoint.id, { ...next.get(endpoint.id), [period]: value });
        } catch (err) {
          failures.push(`${endpoint.key} ${period}: ${err.message}`);
          // The last known value stays.
          const known = this.uptimes.get(endpoint.id)?.[period];
          if (known !== undefined) {
            next.set(endpoint.id, { ...next.get(endpoint.id), [period]: known });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: UPTIME_CONCURRENCY }, worker));
    if (client !== this.client) {
      return false;
    }
    if (failures.length > 0) {
      this.problems.fail('uptime', `Uptimes not read (${failures.length}): ${failures[0]}`);
    } else {
      this.problems.recover('uptime', 'Uptimes read again');
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.uptimes]);
    this.uptimes = next;
    return changed;
  }

  async applySuccess(endpoints) {
    let widgetChanged = this.error !== null || this.readAt === 0;
    if (this.error) {
      logger.info('Gatus answers again');
    }
    if (this.readAt === 0) {
      logger.info(`Gatus (${hostOf(this.config.url)}): ${endpoints.length} endpoint(s)`);
    }
    this.error = null;
    this.readAt = this.now();

    // Everything below up to the events is synchronous: a concurrent read
    // (a new configuration) cannot interleave with it.
    const next = new Map();
    const stateChanged = new Set();
    const events = [];
    let dirty = false;
    for (const endpoint of endpoints) {
      if (next.has(endpoint.id)) {
        continue;
      }
      const previous = this.endpoints.get(endpoint.id);
      endpoint.state = stateFrom(
        endpoint.results,
        this.config.failureThreshold,
        previous?.state ?? this.saved.endpoints[endpoint.id]?.state,
      );
      next.set(endpoint.id, endpoint);
      if (
        !previous ||
        previous.state !== endpoint.state ||
        previous.name !== endpoint.name ||
        previous.group !== endpoint.group
      ) {
        widgetChanged = true;
      }
      if (previous && previous.state !== endpoint.state) {
        stateChanged.add(endpoint.id);
      }
      dirty = this.transition(endpoint, events) || dirty;
    }
    if ([...this.endpoints.keys()].some((id) => !next.has(id))) {
      widgetChanged = true; // an endpoint removed from the Gatus configuration
    }
    this.endpoints = next;
    // An endpoint missing from the answer is forgotten after a day only:
    // after a restart, Gatus (in-memory storage) lists an endpoint once it has
    // a result again, and its outage must still end with "is back up".
    const now = this.now();
    for (const [id, saved] of Object.entries(this.saved.endpoints)) {
      if (next.has(id)) {
        continue;
      }
      if (saved.missingSince === undefined) {
        saved.missingSince = now;
        dirty = true;
      } else if (now - saved.missingSince >= this.timings.forgetMs) {
        delete this.saved.endpoints[id];
        dirty = true;
      }
    }
    // Written only when something changed: no wear of the SD card at every read.
    if (dirty) {
      this.store.save(this.saved);
    }
    for (const [key, endpoint, extra] of events) {
      await this.fire(key, endpoint, extra);
    }
    await this.publishStates({ changed: stateChanged });
    return widgetChanged;
  }

  applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`Gatus: ${err.message}`);
    }
    return wasError !== err.kind;
  }

  /**
   * Compare an endpoint with its last saved state; queue the scene events.
   * @param {object} endpoint with its new `state`
   * @param {Array} events where the events to fire are pushed
   * @returns {boolean} whether the saved state changed
   */
  transition(endpoint, events) {
    const previous = this.saved.endpoints[endpoint.id];
    const { state } = endpoint;
    if (previous?.missingSince !== undefined) {
      delete previous.missingSince;
      if (state === 'unknown' || previous.state === state) {
        return true;
      }
    }
    if (state === 'unknown' || previous?.state === state) {
      return false;
    }
    const now = this.now();
    // An outage starts at its first failed result, when Gatus gave it.
    const since = state === 'down' ? Math.min(now, failingSince(endpoint.results) ?? now) : now;
    this.saved.endpoints[endpoint.id] = { state, since };
    if (!previous) {
      return true; // first sight: no event
    }
    if (state === 'down') {
      logger.info(`${endpoint.name} is down`);
      events.push([TRIGGERS.DOWN, endpoint, { error: failureOf(endpoint) }]);
    } else if (state === 'up') {
      const minutes = Math.max(0, Math.round((now - previous.since) / 60_000));
      logger.info(`${endpoint.name} is up again after ${minutes} min`);
      events.push([TRIGGERS.UP, endpoint, { downtime_minutes: minutes }]);
    }
    return true;
  }

  async fire(key, endpoint, extra = {}) {
    const data = {
      device: endpointIds(this.gladys, endpoint.id).device,
      endpoint: endpoint.name,
      group: endpoint.group,
      ...extra,
    };
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** An endpoint with its uptimes, as the views and the devices read it. */
  view(endpoint) {
    return { ...endpoint, uptimes: this.uptimes.get(endpoint.id) ?? {} };
  }

  list() {
    return [...this.endpoints.values()].map((endpoint) => this.view(endpoint));
  }

  discoveredDevices() {
    const language = this.config.language;
    if (!this.client || this.readAt === 0 || this.error) {
      return null; // nothing read: keep the list Gladys has
    }
    return [
      buildInstanceDevice(this.gladys, language),
      ...[...this.endpoints.values()].map((endpoint) =>
        buildEndpointDevice(this.gladys, endpoint, language),
      ),
    ];
  }

  /** Publish the Discovery list when it changed (an endpoint added, renamed…). */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices() ?? (this.client ? null : []);
    if (devices === null) {
      return;
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Gatus, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.afterChanges(true, { publish: true });
  }

  /**
   * The user added (or updated) a device: its states sent before were dropped
   * by Gladys, and a device deleted then added again needs its badge.
   */
  async onDeviceCreated(device) {
    const id = parseEndpointId(this.gladys, device.external_id);
    if (id) {
      this.volatileAt.delete(id);
    }
    this.transports.delete(device.external_id);
    // The SDK forgets what it sent for this device: everything goes again.
    await this.publishStates({ changed: new Set(id ? [id] : []) });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll, only if it polls anyway). */
  async pollDevice() {
    await this.pollNow();
  }

  /**
   * The states of the added devices. The SDK skips the values Gladys already
   * has (and sends an unchanged one again after `heartbeatMs`).
   * @param {{ changed?: Set<string> }} options endpoints whose volatile features go now
   */
  async publishStates({ changed = new Set() } = {}) {
    if (this.readAt === 0 || this.error) {
      return;
    }
    const now = this.now();
    const states = [];
    let index = -1;
    for (const endpoint of this.endpoints.values()) {
      index += 1;
      const externalId = endpointIds(this.gladys, endpoint.id).device;
      if (!this.isCreated(externalId)) {
        continue; // Gladys drops the states of a device not added
      }
      const volatileDue =
        changed.has(endpoint.id) ||
        !this.volatileAt.has(endpoint.id) ||
        now - this.volatileAt.get(endpoint.id) >= this.timings.volatileEveryMs;
      if (volatileDue) {
        // Spread over the period: a fifth of the endpoints come due each
        // time, not all of them at once.
        const spread = this.volatileAt.has(endpoint.id)
          ? 0
          : ((index % 5) * this.timings.volatileEveryMs) / 5;
        this.volatileAt.set(endpoint.id, now - spread);
      }
      for (const { key, ...state } of endpointValues(this.gladys, this.view(endpoint))) {
        if (volatileDue || !VOLATILE.has(key)) {
          states.push(state);
        }
      }
    }
    if (this.isCreated(instanceIds(this.gladys).device)) {
      for (const { key: _key, ...state } of instanceValues(this.gladys, this.list())) {
        states.push(state);
      }
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local, or unreachable. */
  async publishTransports() {
    if (!this.client || this.readAt === 0) {
      return;
    }
    const transport = this.error ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL;
    const entries = [];
    const ids = [
      instanceIds(this.gladys).device,
      ...[...this.endpoints.keys()].map((id) => endpointIds(this.gladys, id).device),
    ];
    for (const externalId of ids) {
      if (this.isCreated(externalId) && this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (this.config.url === '') {
      return { connected: false, message: CONNECTION_TEXT.noUrl };
    }
    if (!this.config.url) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views and commands (widget, scene actions, report) ----------------------

  /** The endpoint of a device external id (with its uptimes), null when unknown. */
  find(externalId) {
    const id = parseEndpointId(this.gladys, externalId);
    const endpoint = id ? this.endpoints.get(id) : null;
    return endpoint ? this.view(endpoint) : null;
  }

  /** Throws the reason Gatus cannot answer, if any. */
  assertReadable() {
    const status = this.connectionStatus();
    if (!status.connected) {
      throw new Error(pick(status.message, this.config.language));
    }
  }

  /**
   * Push a result to an external endpoint; the timer reads it once the cache
   * of Gatus has expired. `target` is its key (`group_name`), or its name as
   * Gatus shows it.
   */
  async pushExternal(target, { success, error = '' }) {
    const language = this.config.language;
    if (!this.client) {
      this.assertReadable();
    }
    if (!this.config.externalToken) {
      throw new Error(pick(ACTION_TEXT.noToken, language));
    }
    const typed = typeof target === 'string' ? target.trim() : '';
    if (!typed) {
      throw new Error(pick(ACTION_TEXT.noKey, language));
    }
    const lower = typed.toLowerCase();
    const all = [...this.endpoints.values()];
    const byName = all.filter(
      (endpoint) =>
        endpoint.name.toLowerCase() === lower ||
        `${endpoint.group}/${endpoint.name}`.toLowerCase() === lower,
    );
    if (!all.some((endpoint) => endpoint.key === typed) && byName.length > 1) {
      throw new Error(pick(ACTION_TEXT.ambiguous, language));
    }
    const key = all.some((endpoint) => endpoint.key === typed) ? typed : (byName[0]?.key ?? typed);
    try {
      await this.client.pushExternal(key, this.config.externalToken, { success, error });
    } catch (err) {
      throw err instanceof GatusError ? new Error(pick(ERROR_TEXT[err.kind], language)) : err;
    }
    logger.info(`Result pushed to ${key}: ${success ? 'success' : 'failure'}`);
    this.schedulePoll(this.timings.afterPushMs);
  }

  /** "Test the connection": read Gatus now, one line. */
  async testConnection() {
    this.uptimesAt = 0; // read the uptimes too
    await this.pollNow({ publish: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const status = this.connectionStatus();
      if (!status.connected) {
        message[language] = pick(status.message, language);
        continue;
      }
      const endpoints = [...this.endpoints.values()];
      const parts = [text.ok, text.endpoints(endpoints.length)];
      const down = endpoints.filter((endpoint) => endpoint.state === 'down').length;
      if (down > 0) {
        parts.push(text.down(down));
      }
      message[language] = labelled('Gatus', parts.join(', '), language);
    }
    return message;
  }
}

export { ERROR_KINDS };
