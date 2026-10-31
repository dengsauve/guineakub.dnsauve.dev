# TODO.md — Guineakub (Codex-owned)

> Work top to bottom. `HUMAN-TODO.md` contains decisions and actions that require the project owner. Do not treat proposed house rules as finalized.

## Phase 0 — Decisions and specification

- [x] Review `AGENTS.md` and `HUMAN-TODO.md`; flag blocking decisions before gameplay implementation.
- [x] Write `docs/game-rules.md` covering tile composition per player count, opening meld, joker rules, valid groups/runs, drawing, passing, endgame and scoring.
- [x] Write `docs/architecture.md` with trust boundaries, client/server flow, persistence model, Azure free-tier caveats and deployment domains.
- [x] Define acceptance tests for 2, 4, 6 and 8 simultaneous players.

MVP gameplay rules are approved and implemented in the pure engine. Storage recommendation/pricing research is documented in docs/storage-decision.md; owner approved implementation; provisioning remains unapproved. Family enrollment and host controls are approved; credential lifecycle is documented in docs/server.md. Enabled-timer behavior remains deferred. Multiplayer acceptance tests are specified, not run.

## Phase 1 — Monorepo foundation

- [x] Scaffold TypeScript workspace with `apps/web`, `apps/server`, `packages/game-engine`, `packages/protocol`, `infra/azure`.
- [x] Configure formatting, linting, strict TypeScript, test runner and CI.
- [x] Create `.env.example`, `.gitignore`, README and local development scripts.
- [x] Scaffold React + Vite UI and Node.js HTTP/WebSocket service.
- [x] Add shared Zod message schemas and protocol versioning.

## Phase 2 — Pure game engine

- [x] Model uniquely identified physical tiles, colors, numbers, jokers, rack, board, bag, player and room.
- [x] Implement configurable deck creation and seeded shuffle for tests.
- [x] Implement deal, player order, draw, turn lifecycle and winner detection.
- [x] Validate groups, runs, jokers, opening meld and board rearrangements according to approved rules.
- [x] Enforce tile conservation and ownership across every state transition.
- [x] Implement atomic submit, rollback/reset and revision checks.
- [x] Write extensive unit/property-style tests for edge cases and 8-player decks.

The pure engine implements the approved rules with explicit ordered proposal steps, atomic validation, room/round revisions and golf scoring. Tests include generated meld cases, 2/4/6/8-player simulations, frozen-input checks and an 8-player depletion/blocked-round sequence. See docs/game-engine.md. Server identity, command-ID deduplication, filtered network snapshots and durable commits are implemented in Phase 3 below.

## Phase 3 — Server and sessions

- [x] Research minimal Azure storage options; document current pricing, consistency, access controls and recovery/retention tradeoffs. See docs/storage-decision.md; implementation is approved; provisioning remains unapproved.

- [x] Implement room creation, join/invite flow, host controls and capacity enforcement.
- [x] Integrate Google Identity Services; verify ID tokens server-side (issuer, audience, signature, expiry).
- [x] Implement family allowlist and secure server session lifecycle.
- [x] Implement authenticated WebSocket connection, heartbeat and reconnect.
- [x] Implement command validation, idempotency, revisions and per-player state filtering.
- [x] Add durable game snapshots and restart recovery; protect stored secrets and private racks.
- [x] Add rate limiting, safe logging, structured errors and health endpoint.
- [x] Integration-test unauthorized access, cross-player data leakage, stale/duplicate turns and server restart.

Implementation and local integration tests are complete. Live Google browser/OAuth and real Azure identity/conditional-write/recovery smoke tests still require owner account configuration and separately approved resources. See docs/server.md; this is not deployment approval.

## Phase 4 — Playable frontend

- [ ] Build sign-in, room creation, join link and lobby screens.
- [ ] Build shared board, private rack, draw pile indicator and turn status.
- [ ] Add a fun round-start turn-order reveal animation for the server-selected random order, with reduced-motion support.
- [ ] Add tile drag/drop and touch-friendly rearrangement with local draft state.
- [ ] Add Submit Turn, Reset Turn and Draw Tile controls with clear validation feedback.
- [ ] Add reconnect/loading/error states and player presence indicators.
- [ ] Add responsive zoom/pan and accessible alternatives for tile manipulation.
- [ ] Add original guinea pig joker assets once human approves visual direction.
- [ ] Test across desktop and mobile browsers with 8 players.

## Phase 5 — Deployment and operations

- [ ] Write Pulumi configuration for Azure Container Apps (Consumption, min 0/max 1), managed identity and minimal durable storage.
- [ ] Document cold-start, idle scaling, WebSocket and storage-cost implications; verify current Azure limits before deployment.
- [ ] Add Dockerfile and deployment workflow with environment-specific secrets.
- [ ] Add GitHub Pages deployment workflow, Vite base path and custom-domain configuration.
- [ ] Document Cloudflare DNS records, TLS and WebSocket proxy configuration.
- [ ] Add deployment smoke tests, logs, basic alerts and a snapshot recovery procedure.
- [ ] Require human approval before provisioning/deploying infrastructure.

## Phase 6 — Family playtest and polish

- [ ] Run 2-player rules test and 4-player complete game.
- [ ] Run 8-player simulated concurrency test, then real family playtest.
- [ ] Fix board usability, latency, reconnection and joker-rule issues.
- [ ] Write short family-facing instructions and troubleshooting guide.
- [ ] Freeze MVP release after owner approval.

## Explicitly out of scope for MVP

- Public matchmaking, AI opponents, global leaderboards, chat, spectators, multi-region deployment, Kubernetes and multi-replica coordination.
