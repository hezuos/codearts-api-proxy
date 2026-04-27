## 1. Core Implementation

- [x] 1.1 Extend `requireEnv()` in `src/config.ts` to accept optional `hint` parameter — when variable is missing and no fallback, include hint in error message if provided
- [x] 1.2 Add hint to `ENCRYPTION_KEY` `requireEnv()` call — include purpose (encrypts AK/SK credentials), generation command (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), and setup instructions

## 2. Verification

- [x] 2.1 Run `npx tsc --noEmit` — zero errors
- [x] 2.2 Run `pnpm test` — all tests pass
