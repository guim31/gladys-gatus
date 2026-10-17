# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
