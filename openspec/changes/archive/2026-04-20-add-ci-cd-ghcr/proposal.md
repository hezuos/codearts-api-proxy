## Why

The project currently has no CI/CD pipeline. Every release is manual — build, tag, and deploy by hand. Adding a GitHub Actions workflow triggered by git tags will automate release creation and Docker image publishing to GHCR, making deployments reproducible and reducing manual effort.

## What Changes

- Add a `Dockerfile` with multi-stage build (builder + runtime) for minimal image size
- Add a `.dockerignore` to exclude unnecessary files from the build context
- Add a GitHub Actions workflow (`.github/workflows/release.yml`) triggered on `v*` tags that:
  - Builds and tests the project
  - Creates a GitHub Release with auto-generated changelog
  - Builds a Docker image and pushes it to GHCR with version and `latest` tags

## Capabilities

### New Capabilities
- `ci-cd-release`: Automated release and Docker image publishing via GitHub Actions on tag push

### Modified Capabilities

(none — purely additive)

## Impact

- New files: `Dockerfile`, `.dockerignore`, `.github/workflows/release.yml`
- No changes to existing source code
- Requires `GITHUB_TOKEN` permissions for contents:write and packages:write (auto-provided by GitHub Actions with appropriate permissions block)
