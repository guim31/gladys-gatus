// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is this endpoint online?" is already a scene condition on the device
// feature. The reading actions are about what a condition cannot do: put the
// state in a message ("NAS: Down, 97.5 % over 24 h — [STATUS] (502) == 200"),
// and count the endpoints down across the instance or a group, added to Gladys
// or not. Both read Gatus again when the last read is older than 15 seconds.
//
// "Push a result" reports to an external endpoint of Gatus (the token of the
// configuration): a Gladys scene can say it ran, or that something it watches
// failed, and Gatus alerts and keeps the history.
// -----------------------------------------------------------------------------

import { responseTimeOf } from './devices.js';
import { failureOf } from './hub.js';
import { ACTION_TEXT, SENTENCE_TEXT, STATE_TEXT, formatNumber, labelled, pick } from './texts.js';

// Names listed in the `names` output, at most (the rest is counted).
export const MAX_LISTED_NAMES = 20;

// Values of the `result` field of "Push a result": permanent once published.
export const PUSH_RESULTS = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure' });

export const SCENE_ACTIONS = {
  async get_endpoint_status(hub, { fields = {} }) {
    // An error of the last reading is not final: read again first.
    if (!hub.client) {
      hub.assertReadable();
    }
    await hub.refreshIfStale();
    hub.assertReadable();
    const language = hub.config.language;
    const endpoint = hub.find(fields.device);
    if (!endpoint) {
      throw new Error(pick(ACTION_TEXT.unknownEndpoint, language));
    }
    const stateText = pick(STATE_TEXT[endpoint.state], language);
    const responseTime = responseTimeOf(endpoint);
    const uptime = endpoint.uptimes['24h'];
    const parts = [stateText];
    if (endpoint.state === 'up' && responseTime !== null) {
      parts.push(`${responseTime} ms`);
    }
    if (Number.isFinite(uptime)) {
      parts.push(SENTENCE_TEXT[language].uptime(formatNumber(uptime, language)));
    }
    const error = endpoint.state === 'down' ? failureOf(endpoint) : '';
    return {
      online: endpoint.state === 'up',
      state: stateText,
      name: endpoint.name,
      group: endpoint.group,
      response_time: responseTime ?? 0,
      uptime_24h: Number.isFinite(uptime) ? uptime : 0,
      error,
      sentence: `${labelled(endpoint.name, parts.join(', '), language)}.${error ? ` ${error}` : ''}`,
    };
  },

  async count_down_endpoints(hub, { fields = {} }) {
    // An error of the last reading is not final: read again first.
    if (!hub.client) {
      hub.assertReadable();
    }
    await hub.refreshIfStale();
    hub.assertReadable();
    const group = typeof fields.group === 'string' ? fields.group.trim().toLowerCase() : '';
    const endpoints = hub
      .list()
      .filter((endpoint) => !group || endpoint.group.toLowerCase() === group);
    const down = endpoints
      .filter((endpoint) => endpoint.state === 'down')
      .map((endpoint) => endpoint.name)
      .sort((a, b) => a.localeCompare(b));
    const listed = down.slice(0, MAX_LISTED_NAMES);
    return {
      down: down.length,
      total: endpoints.length,
      names:
        down.length > listed.length
          ? `${listed.join(', ')}, +${down.length - listed.length}`
          : listed.join(', '),
    };
  },

  async push_external_result(hub, { fields = {} }) {
    await hub.pushExternal(fields.endpoint, {
      success: fields.result !== PUSH_RESULTS.FAILURE,
      error: typeof fields.error === 'string' ? fields.error.trim() : '',
    });
  },
};
