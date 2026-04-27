---
spec: version-display
status: implemented
priority: low
created: 2026-04-28
updated: 2026-04-28
---

# Version Display

## Overview

The system SHALL display build version metadata (version, git commit, build time) on all HTML pages and in health/ready API responses.

## Requirements

### Requirement: Version badge on pages with nav

The system SHALL display version info in the right side of the `.nav` element on pages that have a nav bar (index, admin, success). The badge SHALL show version, git commit hash, and build time separated by " · ".

#### Scenario: Version displayed in nav

- **WHEN** a page with a `.nav` element loads and `/health` returns successfully
- **THEN** the version badge SHALL appear at the right end of the nav bar showing "v{version} · {gitCommit} · {buildTime}"

#### Scenario: Health fetch fails on nav page

- **WHEN** a page with a `.nav` element loads and `/health` fetch fails
- **THEN** the version placeholder SHALL be hidden with no error shown to the user

### Requirement: Version badge on pages without nav

The system SHALL display version info next to the `<h1>` heading on pages that do not have a nav bar (admin-login, admin-setup).

#### Scenario: Version displayed next to heading

- **WHEN** a page without a `.nav` element loads and `/health` returns successfully
- **THEN** the version badge SHALL appear to the right of the `<h1>` heading showing "v{version} · {gitCommit} · {buildTime}"

#### Scenario: Health fetch fails on non-nav page

- **WHEN** a page without a `.nav` element loads and `/health` fetch fails
- **THEN** the version placeholder SHALL be hidden with no error shown to the user

### Requirement: Version info sourced from build metadata

The version info SHALL be generated at build/dev time from `package.json` version, git commit hash (`git rev-parse --short HEAD`), and build timestamp. These SHALL be exported from `src/version.ts` as `APP_VERSION`, `GIT_COMMIT`, and `BUILD_TIME`.

#### Scenario: Version matches package.json

- **WHEN** the server starts with `package.json` version "1.4.1" and git commit "0ebf53c"
- **THEN** `/health` SHALL return `{ status: "ok", version: "1.4.1", gitCommit: "0ebf53c", buildTime: "<timestamp>" }`

#### Scenario: No git repository

- **WHEN** the server is built outside a git repository
- **THEN** `gitCommit` SHALL be "unknown" and the badge SHALL omit the commit portion
