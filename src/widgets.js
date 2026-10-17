// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `gatus`.
//
// The use case: a glance at the wall tablet tells whether the self-hosted
// services answer, and which one does not. Three tiles (endpoints down, up,
// average uptime over 24 hours), then one status list:
//   - ten endpoints or fewer: one row per endpoint, the ones down first, with
//     their group, response time and uptime;
//   - more: one row per Gatus group ("2 down / 7"), the groups with an
//     endpoint down first — the Gatus dashboard, folded.
//
// Every endpoint by default, or one group, or the devices chosen in the
// widget settings. The figures are sent as values, not bound to device
// features: the widget works before the devices are added.
//
// Budget (8 components, 2 texts, 1 status): three tiles, one text when Gatus
// does not answer, the status list, a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { responseTimeOf } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, NO_GROUP, STATE_TEXT, formatNumber, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  pick: {
    en: 'Enter the address of your Gatus in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre Gatus dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines Gatus in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su Gatus en la configuración de la integración.',
  },
  empty: {
    en: 'No endpoint to show: check the group chosen, or the Gatus configuration.',
    fr: "Aucun point d'accès à afficher : vérifiez le groupe choisi, ou la configuration de Gatus.",
    de: 'Kein Endpunkt anzuzeigen: Prüfe die gewählte Gruppe oder die Gatus-Konfiguration.',
    es: 'Ningún endpoint que mostrar: compruebe el grupo elegido o la configuración de Gatus.',
  },
  down: { en: 'Down', fr: 'En panne', de: 'Ausgefallen', es: 'Caídos' },
  up: { en: 'Up', fr: 'En ligne', de: 'Online', es: 'En línea' },
  uptime: { en: 'Uptime 24 h', fr: 'Dispo. 24 h', de: 'Verfügbar 24 h', es: 'Dispon. 24 h' },
  groupDown: { en: 'down', fr: 'en panne', de: 'ausgefallen', es: 'caídos' },
  groupUp: { en: 'up', fr: 'en ligne', de: 'online', es: 'en línea' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Gatus read again.',
    fr: 'Gatus relu.',
    de: 'Gatus neu gelesen.',
    es: 'Gatus leído de nuevo.',
  },
};

// Row order: what needs attention first.
const SEVERITY = ['down', 'unknown', 'up'];

const ROW_STYLE = {
  down: { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  unknown: { icon: 'circle', color: WIDGET_COLORS.NEUTRAL },
  up: { icon: 'check-circle', color: WIDGET_COLORS.SUCCESS },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** The endpoints the widget shows: the chosen devices, else a group, else all. */
export function selectEndpoints(hub, settings) {
  const chosen = [settings?.endpoints ?? []].flat().filter((id) => typeof id === 'string' && id);
  if (chosen.length > 0) {
    return [...new Set(chosen)].map((id) => hub.find(id)).filter(Boolean);
  }
  const group = typeof settings?.group === 'string' ? settings.group.trim().toLowerCase() : '';
  return hub.list().filter((endpoint) => !group || endpoint.group.toLowerCase() === group);
}

const byName = (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name);

export function sortEndpoints(endpoints) {
  return [...endpoints].sort(
    (a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state) || byName(a, b),
  );
}

const percent = (value, language) => `${formatNumber(value, language)} %`;

function endpointRow(endpoint, language) {
  const parts = [];
  const responseTime = responseTimeOf(endpoint);
  if (endpoint.state !== 'up') {
    parts.push(pick(STATE_TEXT[endpoint.state], language));
  } else if (responseTime !== null) {
    parts.push(`${responseTime} ms`);
  }
  if (Number.isFinite(endpoint.uptimes['24h'])) {
    parts.push(percent(endpoint.uptimes['24h'], language));
  }
  return {
    label: fit(endpoint.group ? `${endpoint.group} · ${endpoint.name}` : endpoint.name, 40),
    value: fit(parts.join(' · ') || pick(STATE_TEXT[endpoint.state], language), 40),
    ...ROW_STYLE[endpoint.state],
  };
}

function groupRows(endpoints, language) {
  const groups = new Map();
  for (const endpoint of endpoints) {
    const list = groups.get(endpoint.group) ?? [];
    list.push(endpoint);
    groups.set(endpoint.group, list);
  }
  return [...groups]
    .map(([group, list]) => {
      const down = list.filter((endpoint) => endpoint.state === 'down').length;
      const up = list.filter((endpoint) => endpoint.state === 'up').length;
      return {
        down,
        label: fit(group || pick(NO_GROUP, language), 40),
        value:
          down > 0
            ? `${down} ${pick(TEXT.groupDown, language)} / ${list.length}`
            : `${up}/${list.length} ${pick(TEXT.groupUp, language)}`,
        ...ROW_STYLE[down > 0 ? 'down' : up === list.length ? 'up' : 'unknown'],
      };
    })
    .sort((a, b) => b.down - a.down || a.label.localeCompare(b.label))
    .map(({ down: _down, ...row }) => row);
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return message(TEXT.pick, language);
  }
  const endpoints = sortEndpoints(selectEndpoints(hub, settings));
  if (endpoints.length === 0 && !hub.error) {
    return message(TEXT.empty, language);
  }

  const down = endpoints.filter((endpoint) => endpoint.state === 'down').length;
  const uptimes = endpoints
    .map((endpoint) => endpoint.uptimes['24h'])
    .filter((value) => Number.isFinite(value));
  const components = [
    {
      type: 'value',
      value: down,
      label: pick(TEXT.down, language),
      icon: 'x-circle',
      color: down > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: endpoints.filter((endpoint) => endpoint.state === 'up').length,
      label: pick(TEXT.up, language),
      icon: 'check-circle',
      color: WIDGET_COLORS.SUCCESS,
    },
  ];
  if (uptimes.length > 0) {
    const average = uptimes.reduce((sum, value) => sum + value, 0) / uptimes.length;
    components.push({
      type: 'value',
      value: Math.round(average * 100) / 100,
      unit: '%',
      label: pick(TEXT.uptime, language),
      icon: 'activity',
      color: average < 99 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    });
  }

  if (hub.error) {
    components.push({
      type: 'text',
      variant: 'body',
      text: pick(ERROR_TEXT[hub.error.kind], language),
    });
  }

  if (endpoints.length > 0) {
    let rows =
      endpoints.length <= MAX_ROWS
        ? endpoints.map((endpoint) => endpointRow(endpoint, language))
        : groupRows(endpoints, language);
    if (rows.length > MAX_ROWS) {
      const hidden = rows.length - (MAX_ROWS - 1);
      rows = [
        ...rows.slice(0, MAX_ROWS - 1),
        {
          label: pick(TEXT.more, language),
          value: `+${hidden}`,
          icon: 'more-horizontal',
          color: WIDGET_COLORS.NEUTRAL,
        },
      ];
    }
    components.push({ type: 'status', items: rows });
  }

  components.push({
    type: 'button',
    label: pick(TEXT.refresh, language),
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: ACTIONS.REFRESH },
  });

  // An endpoint down moves: refresh sooner.
  return { ttl_seconds: hub.error || down > 0 ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollNow();
  if (hub.error) {
    return { message: ERROR_TEXT[hub.error.kind] };
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
