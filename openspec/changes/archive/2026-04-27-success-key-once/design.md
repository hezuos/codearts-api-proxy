## Context

The success page (`public/success.html`) is shown after a user completes Huawei Cloud login. The server returns the full API key via `/api/ui/login-result` (as long as the `auth_key` cookie is valid). Currently the key has a Show/Hide toggle, but Usage Examples always show the key in plaintext. There is no prompt to save the key.

## Goals / Non-Goals

**Goals:**
- Make it obvious that the API key should be saved immediately
- After user confirms saving, mask the key everywhere on the page
- Prevent casual re-viewing within the same browser session

**Non-Goals:**
- Server-side one-time token enforcement (overkill for this threat model)
- Preventing key retrieval via API calls (the key is in the cookie; server-side changes are out of scope)
- Hiding the key from browser DevTools or network tab

## Decisions

### 1. Confirmation flow: "I've saved it" button

**Decision**: Show the full key on first view with a prominent warning. Add a "I've saved my key" button. After clicking, mask the key everywhere and remove the Show button.

**Rationale**: Balances security awareness with usability. The user gets one clear chance to copy the key, then it's masked. No forced countdown or auto-hide that might surprise users.

**Alternatives considered**:
- Auto-hide after N seconds: stressful, user might not finish copying
- Never show the key at all (copy-only): less usable for users who want to verify

### 2. Session persistence: sessionStorage

**Decision**: Use `sessionStorage` to remember that the user confirmed. On page refresh within the same tab/session, auto-mask. New tab/window allows one more view.

**Rationale**: `sessionStorage` is per-tab and cleared when the tab closes. This means closing and reopening the page in a new tab gives another chance to view — which is reasonable since the cookie is still valid. `localStorage` would be too persistent (survives browser restart).

**Alternatives considered**:
- `localStorage`: too persistent, would mask even after days
- Server-side token: requires backend changes, overkill

### 3. Usage Examples key masking

**Decision**: After confirmation, replace the full key in Usage Examples with the masked version. Before confirmation, show the full key (this is the one-time view).

**Rationale**: Currently Usage Examples always show the full key, which undermines the Show/Hide toggle. After confirmation, consistency demands the key be masked everywhere.

## Risks / Trade-offs

- [sessionStorage is per-tab, not per-user] → Mitigation: Acceptable for this threat model. The server still returns the key if cookie is valid; we're improving UX awareness, not enforcing hard security.
- [User might close the tab before saving] → Mitigation: The warning banner is prominent. New tab allows re-view. This is a UX improvement, not a security guarantee.
