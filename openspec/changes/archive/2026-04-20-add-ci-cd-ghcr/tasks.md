## 1. Dockerfile and .dockerignore

- [x] 1.1 Create `Dockerfile` with three-stage build: builder (pnpm install + build), prod-deps (pnpm install --prod), and runtime (copy artifacts, non-root user, EXPOSE 1455, CMD)
- [x] 1.2 Create `.dockerignore` excluding node_modules, data, .git, .opencode, docs, openspec, scripts, tests, examples, *.log

## 2. GitHub Actions Workflow

- [x] 2.1 Create `.github/workflows/release.yml` triggered on `v*` tag push
- [x] 2.2 Add build and test steps: checkout, setup Node 20, setup pnpm, install, build, test
- [x] 2.3 Add GitHub Release step using `softprops/action-gh-release`
- [x] 2.4 Add Docker build and push step: login to GHCR, buildx build, push with version tag and `latest`
- [x] 2.5 Add `permissions: contents:write, packages:write` to the workflow

## 3. Validation

- [x] 3.1 Verify Dockerfile builds successfully locally
- [x] 3.2 Verify the workflow YAML is valid (actionlint or manual review)
