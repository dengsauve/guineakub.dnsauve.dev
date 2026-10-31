# AGENTS.md — Guineakub

## Mission

Build **Guineakub**, a private, browser-based, Rummikub-inspired multiplayer game for family game nights. Support up to **8 simultaneous players in one room**, with guinea pig artwork on joker tiles. Prioritize a delightful, reliable experience over scale or feature breadth.

## Architecture decisions

- Monorepo using TypeScript.
- `apps/web`: React + Vite, deployed to GitHub Pages (static only).
- `apps/server`: lightweight Node.js WebSocket + HTTP service, deployed as a single Azure Container Apps Consumption replica (min 0, max 1).
- `packages/game-engine`: pure TypeScript game model, rules, deterministic operations and tests; no network, React or Azure dependencies.
- `packages/protocol`: shared versioned messages and Zod validation schemas.
- `infra/azure`: Pulumi IaC; never hardcode credentials.
- Cloudflare for domain DNS and optional proxying; distinguish GitHub Pages hostname from Azure API/WebSocket hostname.
- Google sign-in is required for all MVP players; no guest access. Google Identity Services for login; backend verifies Google ID tokens and issues/validates its own session credentials. Allowlist family members by stable Google `sub` identifiers, not display names. Provide a secure invitation/onboarding process; never put secrets in frontend bundles.
- External durable snapshot storage for games. Container filesystem and process memory are ephemeral. Choose a minimal Azure storage option after documenting cost, consistency, and access controls.
- WebSockets over TLS (`wss://`); HTTPS for health/auth and any necessary initial session endpoints.

## Product constraints

- 2–8 people can play together in a private room; **up to 8 players on one shared board** is confirmed by the owner.
- Approved deck compositions: 2–4 players use 106 tiles (two copies of each numbered color tile + two jokers); 5–6 use 160 (three copies + four jokers); 7–8 use 214 (four copies + six jokers). Each numbered copy contains four colors numbered 1–13.
- Approved: initial rack 14 tiles; rack-only opening melds total at least 30 points, with jokers valued as represented numbers. Board manipulation is allowed in that same turn only after completing the opening. Turn timer defaults off; remaining house-rule details require confirmation before freezing the engine.
- Each player has a private rack; opponents cannot see its contents or draw-pile order.
- Joker tiles use original guinea pig art; do not copy commercial game assets, logos, or protected artwork.
- Favor accessibility, keyboard/touch support, responsive layout and legible tiles. Board UX is a major engineering risk, especially with 8 players.
- MVP does not require matchmaking, chat, leaderboards, spectators, or AI opponents.

## Game-state rules

- Server is authoritative. Clients submit **commands/proposed turns**, never authoritative game state.
- A turn is edited locally, then submitted atomically. Provide Reset Turn, Draw Tile and Submit Turn.
- Server validates identity, room membership, turn ownership, expected state revision, rack ownership, meld legality, joker constraints, and tile conservation.
- Persist accepted state transitions before acknowledging and broadcasting them. Use a monotonic game revision and an idempotency key per command.
- Do not broadcast other players' racks or the draw-pile sequence. Filter all server snapshots and events per viewer.
- Reconnect by authenticating again and requesting a viewer-filtered snapshot with the current revision.
- Handle disconnects, browser refreshes, duplicate commands, invalid submissions, stale revisions and process restarts safely.
- Only one active game-server replica initially; do not introduce Redis, Kubernetes, SignalR or distributed coordination without a demonstrated need.

## Development workflow for Codex

1. Read `AGENTS.md`, `TODO.md`, and `HUMAN-TODO.md` before making changes.
2. Work in small, reviewable increments; update TODO checkboxes as work is completed. Do not mark human-owned tasks complete without confirmation.
3. Ask the human to decide unresolved game rules, infrastructure costs or authentication UX rather than silently inventing policy.
4. Prefer simple, idiomatic TypeScript, pure functions, typed boundaries, and few dependencies.
5. Add automated tests for all game-engine changes, especially jokers, opening meld, tile conservation, multi-set decks and turn rollback.
6. Add integration tests for server-side authorization, hidden information, reconnection, state revisions and persistence recovery.
7. Run lint, typecheck and relevant tests before claiming completion. Report what was and wasn't executed.
8. Never deploy, provision paid resources, buy a domain, change DNS, or commit secrets without explicit human approval.
9. Document local setup, required environment variables, deployment steps, and operational recovery in README/docs.
10. Keep a `.env.example`; never check in `.env`, credentials, session tokens, private keys, or real player data.

## Suggested layout

```text
apps/web/
apps/server/
packages/game-engine/
packages/protocol/
infra/azure/
docs/
.github/workflows/
AGENTS.md
TODO.md
HUMAN-TODO.md
```

## Acceptance criteria for MVP

- A host creates a private room and invites up to 7 other players.
- Approved family members sign in and reconnect without losing their rack or game state.
- All players see the same committed board and correct turn order; each sees only their own rack.
- Server rejects illegal turns and conflicting revisions without corrupting state.
- The game survives browser refresh and server restart.
- Joker tiles render with original guinea pig artwork.
- GitHub Pages serves the frontend; Azure serves HTTPS/WSS; Cloudflare DNS resolves both hostnames.
- Automated tests pass and deployment instructions are reproducible.
