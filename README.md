# Gatus for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings the endpoints of a [Gatus](https://github.com/TwiN/gatus) status
page into Gladys: the websites, APIs, DNS and ports that Gatus checks.

- **One device per endpoint**: online (green/red badge), response time of the
  last successful check, uptime over 24 hours and 7 days.
- **One instance device**: endpoints down and in total.
- **Scene triggers**: an endpoint goes down (after a chosen number of failed
  checks in a row, with what failed), is back up (with the outage length) —
  for any endpoint, added to Gladys or not.
- **Scene actions**: state of an endpoint (with a ready-made sentence), count
  the endpoints down (in a group or everywhere), push a success or failure to
  a Gatus external endpoint.
- **Dashboard widget**: endpoints down first, by group.
- Texts in English, French, German and Spanish.

Tested against a real Gatus in Docker (build of 16 October 2026): endpoints
up, failing and stopped, groups, an external endpoint, basic login. Feedback
welcome on [the issues](https://github.com/guim31/gladys-gatus/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- A Gatus reachable from Gladys (port 8080 by default). Basic login
  (`security.basic`) is supported, OIDC is not.

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-gatus`. Then open its configuration, enter
the address of Gatus, and add the endpoints from the Discover tab.

The full guide: [docs/en.md](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

The container reads `GET /api/v1/endpoints/statuses` at the chosen interval
(one request every minute by default, with as many results per endpoint as
the failure threshold), and the uptimes (`/api/v1/endpoints/{key}/uptimes/24h`
and `7d`) every 5 minutes. It publishes the states of the devices added to
Gladys when they change, and fires the scene events on the transitions of
every endpoint. The last state of each endpoint is kept in `/data`, so an
endpoint that went down during a restart is announced once. Redirects are not
followed, so the credentials are never sent to another host.

## Limits

- One Gatus instance per configuration.
- Read-mostly: endpoints are not created or edited from Gladys; only external
  endpoints receive results.
- An outage shorter than the refresh interval may not be seen.
- A self-signed HTTPS certificate is not accepted (use `http://` on the local
  network).

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on the Gatus
API.

## Credits

- [Gatus](https://github.com/TwiN/gatus) by TwiN and contributors
  (Apache-2.0): the API answer in `test/fixtures/gatus` comes from its Docker
  image, the key rules from its code.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and on the architecture of
  [gladys-healthchecks](https://github.com/guim31/gladys-healthchecks).

Not affiliated with Gatus or its author.

## License

Apache-2.0, see [LICENSE](LICENSE).
