## Context

The project is a Node.js/TypeScript proxy using pnpm, targeting Node >= 20. Build output goes to `dist/`. Runtime needs `dist/`, `public/` (static files), and production `node_modules/`. The `data/` directory holds runtime state and must be mounted as a volume. No existing Dockerfile or CI/CD configuration.

## Goals / Non-Goals

**Goals:**
- Automate release creation on git tag push (`v*` pattern)
- Build and push Docker image to GHCR (`ghcr.io/<owner>/codearts-agent-proxy`)
- Tag Docker images with both the version (e.g., `v1.0.0`) and `latest`
- Minimal Docker image via multi-stage build
- Run tests before release to prevent broken releases

**Non-Goals:**
- CI on every push (PR checks, linting on push) — can be added later
- Multi-arch builds (arm64/amd64) — start with amd64 only, can extend later
- Deployment automation (k8s, docker-compose) — out of scope
- Semantic versioning enforcement — assume tags are manually created and well-formed

## Decisions

### 1. Dockerfile: three-stage build with pnpm

**Decision:** Three stages — `builder` (install all + build), `prod-deps` (install production deps only), and `runtime` (copy artifacts from both).

**Rationale:** Multi-stage build keeps the final image small (~100MB vs ~500MB with dev deps). Using pnpm matches the project's package manager. We use three stages instead of two because `pnpm deploy --prod` only works inside a workspace, which this project is not. The separate `prod-deps` stage installs `--prod` dependencies independently.

```
Stage 1 (builder):    node:20-alpine + pnpm
  - pnpm install --frozen-lockfile
  - pnpm build → dist/

Stage 2 (prod-deps):  node:20-alpine + pnpm
  - pnpm install --frozen-lockfile --prod

Stage 3 (runtime):    node:20-alpine (clean)
  - COPY dist/ public/ from builder
  - COPY node_modules/ from prod-deps
  - COPY package.json from builder
  - USER node (non-root)
  - EXPOSE 1455
  - CMD ["node", "dist/index.js"]
```

### 2. GitHub Actions workflow: single job with sequential steps

**Decision:** Use a single job rather than multiple jobs with dependencies. The workflow runs: checkout → setup pnpm → install → build → test → create release → docker build+push.

**Rationale:** Multiple jobs would require uploading build artifacts and re-downloading them, adding complexity for no real benefit in this small project. A single job is simpler and faster.

### 3. GHCR image naming

**Decision:** Image name `ghcr.io/<owner>/codearts-agent-proxy`, tagged with both the git tag version and `latest`.

**Rationale:** Follows GHCR convention. The `<owner>` is derived from `github.repository_owner`. `latest` tag always points to the most recent release.

### 4. Release creation

**Decision:** Use `softprops/action-gh-release` to create the GitHub Release with auto-generated notes.

**Rationale:** This action handles release creation, changelog generation from commits since last tag, and artifact uploads in a single step. Well-maintained and widely used.

## Risks / Trade-offs

- **[Tag format mismatch]** → Mitigation: Workflow only triggers on `v*` tags; non-conforming tags are ignored
- **[GITHUB_TOKEN permissions insufficient]** → Mitigation: Explicit `permissions: contents:write, packages:write` in the workflow
- **[pnpm not available in Docker]** → Mitigation: Install pnpm via `corepack enable` in each stage that needs it (Node 20 includes corepack)
- **[pnpm deploy requires workspace]** → Mitigation: Use a separate `prod-deps` stage with `pnpm install --prod` instead of `pnpm deploy`
- **[Tests fail on tag push]** → Mitigation: Test step runs before release/docker steps; if tests fail, the workflow stops and no release or image is published
