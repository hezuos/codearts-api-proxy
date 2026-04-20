---
spec: ci-cd-release
status: implemented
priority: high
created: 2026-04-20
updated: 2026-04-20
---

# CI/CD Release

## Overview

Automated release creation and Docker image publishing via GitHub Actions, triggered by git tag pushes.

## Requirements

### Requirement: Tag-triggered release workflow
The system SHALL provide a GitHub Actions workflow that triggers on git tag pushes matching `v*` and automates build, test, release creation, and Docker image publishing.

#### Scenario: Tag v1.0.0 pushed
- **WHEN** a git tag matching `v*` (e.g., `v1.0.0`) is pushed to the repository
- **THEN** the workflow SHALL run: install dependencies, build, test, create a GitHub Release, build a Docker image, and push it to GHCR

#### Scenario: Non-version tag pushed
- **WHEN** a git tag not matching `v*` (e.g., `rc1`) is pushed
- **THEN** the workflow SHALL NOT trigger

### Requirement: Build and test before release
The workflow SHALL build the project and run tests before creating any release artifacts. If tests fail, no release or Docker image SHALL be published.

#### Scenario: Tests pass
- **WHEN** `pnpm build` and `pnpm test` both succeed
- **THEN** the workflow SHALL proceed to create the release and push the Docker image

#### Scenario: Tests fail
- **WHEN** `pnpm test` fails
- **THEN** the workflow SHALL stop and no release or Docker image SHALL be created

### Requirement: GitHub Release creation
The workflow SHALL create a GitHub Release with auto-generated release notes from commits since the previous tag.

#### Scenario: Release created for v1.0.0
- **WHEN** the workflow runs for tag `v1.0.0`
- **THEN** a GitHub Release SHALL be created with tag `v1.0.0` and auto-generated body from commit history

### Requirement: Docker image published to GHCR
The workflow SHALL build a Docker image and push it to GHCR with both the version tag and `latest`.

#### Scenario: Docker image pushed
- **WHEN** the workflow runs for tag `v1.0.0`
- **THEN** the Docker image SHALL be pushed to `ghcr.io/<owner>/codearts-agent-proxy` with tags `v1.0.0` and `latest`

### Requirement: Dockerfile three-stage build
The Dockerfile SHALL use a three-stage build (builder, prod-deps, runtime) to produce a minimal runtime image containing only compiled code, production dependencies, and static assets. The `prod-deps` stage is separate because `pnpm deploy` requires a workspace, which this project is not.

#### Scenario: Runtime image contents
- **WHEN** the Docker image is built
- **THEN** it SHALL contain `dist/`, `public/`, production `node_modules/`, and `package.json`, but NOT dev dependencies, source files, or build tools

#### Scenario: Runtime runs as non-root
- **WHEN** the Docker container starts
- **THEN** the Node.js process SHALL run as a non-root user
