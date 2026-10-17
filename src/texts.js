// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, endpoint states, the "Test the connection"
// report, scene outputs and errors. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks every
// table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './gatus/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of your Gatus in the configuration.',
    fr: "Saisissez l'adresse de votre Gatus dans la configuration.",
    de: 'Gib die Adresse deines Gatus in der Konfiguration ein.',
    es: 'Introduzca la dirección de su Gatus en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:8080',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:8080',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:8080',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:8080',
  },
};

// One short explanation per error kind (src/gatus/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'Gatus does not answer',
    fr: 'Gatus ne répond pas',
    de: 'Gatus antwortet nicht',
    es: 'Gatus no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: use an http:// address or a trusted certificate',
    fr: 'certificat refusé : utilisez une adresse http:// ou un certificat reconnu',
    de: 'Zertifikat abgelehnt: Nutze eine http://-Adresse oder ein vertrauenswürdiges Zertifikat',
    es: 'certificado rechazado: use una dirección http:// o un certificado reconocido',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'Gatus asks for a login: check the user and password (OIDC is not supported)',
    fr: "Gatus demande une connexion : vérifiez l'utilisateur et le mot de passe (OIDC non pris en charge)",
    de: 'Gatus verlangt eine Anmeldung: Prüfe Benutzer und Passwort (OIDC wird nicht unterstützt)',
    es: 'Gatus pide iniciar sesión: compruebe el usuario y la contraseña (OIDC no es compatible)',
  },
  [ERROR_KINDS.NOT_GATUS]: {
    en: 'no Gatus at this address',
    fr: 'aucun Gatus à cette adresse',
    de: 'kein Gatus unter dieser Adresse',
    es: 'no hay ningún Gatus en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'no external endpoint with this key in Gatus',
    fr: "aucun point d'accès externe avec cette clé dans Gatus",
    de: 'kein externer Endpunkt mit diesem Schlüssel in Gatus',
    es: 'ningún endpoint externo con esta clave en Gatus',
  },
  [ERROR_KINDS.TOKEN]: {
    en: 'token refused by the external endpoint',
    fr: "jeton refusé par le point d'accès externe",
    de: 'Token vom externen Endpunkt abgelehnt',
    es: 'token rechazado por el endpoint externo',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The state of an endpoint, in words (widget rows, scene outputs).
export const STATE_TEXT = {
  up: { en: 'Up', fr: 'En ligne', de: 'Online', es: 'En línea' },
  down: { en: 'Down', fr: 'En panne', de: 'Ausgefallen', es: 'Caído' },
  unknown: {
    en: 'No result yet',
    fr: 'Aucun résultat',
    de: 'Noch kein Ergebnis',
    es: 'Sin resultado',
  },
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'Connected',
    endpoints: (count) => `${count} endpoint(s)`,
    down: (count) => `${count} down`,
  },
  fr: {
    ok: 'Connecté',
    endpoints: (count) => `${count} point(s) d'accès`,
    down: (count) => `${count} en panne`,
  },
  de: {
    ok: 'Verbunden',
    endpoints: (count) => `${count} Endpunkt(e)`,
    down: (count) => `${count} ausgefallen`,
  },
  es: {
    ok: 'Conectado',
    endpoints: (count) => `${count} endpoint(s)`,
    down: (count) => `${count} caído(s)`,
  },
};

// Errors of the scene actions (shown in Gladys).
export const ACTION_TEXT = {
  unknownEndpoint: {
    en: 'This device is not a Gatus endpoint.',
    fr: "Cet appareil n'est pas un point d'accès Gatus.",
    de: 'Dieses Gerät ist kein Gatus-Endpunkt.',
    es: 'Este dispositivo no es un endpoint de Gatus.',
  },
  noToken: {
    en: 'Enter the token of the external endpoints in the configuration of the integration.',
    fr: "Saisissez le jeton des points d'accès externes dans la configuration de l'intégration.",
    de: 'Gib das Token der externen Endpunkte in der Konfiguration der Integration ein.',
    es: 'Introduzca el token de los endpoints externos en la configuración de la integración.',
  },
  ambiguous: {
    en: 'Several endpoints have this name: enter the key of the external endpoint.',
    fr: "Plusieurs points d'accès portent ce nom : saisissez la clé du point d'accès externe.",
    de: 'Mehrere Endpunkte tragen diesen Namen: Gib den Schlüssel des externen Endpunkts ein.',
    es: 'Varios endpoints tienen este nombre: introduzca la clave del endpoint externo.',
  },
  noKey: {
    en: 'Enter the key of the external endpoint, e.g. backups_nightly-job.',
    fr: "Saisissez la clé du point d'accès externe, ex. backups_nightly-job.",
    de: 'Gib den Schlüssel des externen Endpunkts ein, z. B. backups_nightly-job.',
    es: 'Introduzca la clave del endpoint externo, p. ej. backups_nightly-job.',
  },
};

// The `sentence` output of "State of an endpoint".
export const SENTENCE_TEXT = {
  en: { uptime: (value) => `${value} % over 24 h` },
  fr: { uptime: (value) => `${value} % sur 24 h` },
  de: { uptime: (value) => `${value} % in 24 h` },
  es: { uptime: (value) => `${value} % en 24 h` },
};

// Shown when an endpoint has no group.
export const NO_GROUP = { en: 'No group', fr: 'Sans groupe', de: 'Ohne Gruppe', es: 'Sin grupo' };

export const LANGUAGE_FALLBACK = 'en';

const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

/** A number in the conventions of the language (decimal comma in fr, de, es). */
export const formatNumber = (value, language) =>
  new Intl.NumberFormat(LOCALES[language] ?? LOCALES.en, { maximumFractionDigits: 2 }).format(
    value,
  );

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
