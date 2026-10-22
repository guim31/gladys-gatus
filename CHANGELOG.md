# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-22

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

## [1.0.0] - 2026-10-17

### Added

- One device per Gatus endpoint: online, response time, uptime over 24 hours
  and 7 days; one device for the instance: endpoints down and in total.
- Scene triggers "An endpoint goes down" (after a chosen number of failed
  checks in a row, with what failed) and "An endpoint is back up" (with the
  outage length), for any endpoint.
- Scene actions "State of an endpoint" (with a ready-made sentence), "Count the
  endpoints down" (everywhere or in a group) and "Push a result to Gatus" (to
  an external endpoint).
- Dashboard widget: endpoints down first, by group, with response time and
  uptime.
- Basic login (`security.basic`), refresh interval from 30 seconds to 5
  minutes, "Test the connection" action.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-gatus/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-gatus/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-gatus/releases/tag/v1.0.0
