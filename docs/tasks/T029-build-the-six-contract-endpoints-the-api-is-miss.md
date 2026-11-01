---
id: T029
title: Build the six contract endpoints the API is missing
status: done
depends: [T027]
estimate: 110000
---

## Goal

Every endpoint in docs/website/api-contract.md exists in the API, so the contract and the OpenAPI document match both ways.

## Scope

In the worktree E:/Runova-website (apps/website/api), build what the contract lists but the API lacks: PUT /api/v1/users/me/password (change own password, current password required), DELETE /api/v1/users/me/two-factor (turn off own 2FA), POST /api/v1/users/me/two-factor/recovery-codes (new recovery codes, shown once), GET /api/v1/audit-entries (Admin, paged), GET /api/v1/media (paged list) and DELETE /api/v1/media/{id} (409 while a post uses it as its cover). Follow the contract's auth, status codes and problem details. Then make ApiConventionTests also check the other way, that every contract row is in the OpenAPI document. Update the OpenAPI snapshot. Site pages for these are out of scope unless the contract or the admin spec already asks for them.

## Acceptance criteria

- [ ] Each of the six endpoints answers with exactly the status codes in its contract row, with integration tests for each code
- [ ] Every write needs credentials and antiforgery like the existing writes (AuthorizationTests covers the new ones)
- [ ] Recovery codes and passwords never appear in logs, Sentry events or spans (the stack secrets spec covers the new calls)
- [ ] ApiConventionTests fails on a contract row with no matching OpenAPI operation, and passes
- [ ] pnpm website-api:format:check, website-api:build and website-api:test pass

## Test plan

Write the reverse convention check first and watch it fail on the six missing rows, then an integration test per endpoint and status code, then the code. Extend e2e/stack/secrets.spec.ts with a password change and new recovery codes. Run the API gates and bun run e2e:stack on the test stack (compose.yaml plus compose.test.yaml).
