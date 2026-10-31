# Guineakub

Private family tile game under construction. The pure game engine implements the approved MVP rules; see [game rules](docs/game-rules.md), [architecture](docs/architecture.md), [acceptance scenarios](docs/acceptance-tests.md), and HUMAN-TODO.md.

## Local development

Use Node 22.13+ (22.x), 24.x, or 26+ and npm. Run `npm ci`, then `npm run dev:web` and `npm run dev:server` in separate terminals. Vite prints its local URL; the server binds http://127.0.0.1:3000. GET `/health` returns liveness; `/ready` requires auth configuration. The server implements approved Google sign-in, sessions, private rooms and authenticated protocol-v2 WebSockets. The UI is not playable yet. See [server setup and recovery](docs/server.md).

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check`. Use `npm run format` to format. CI executes these checks. Build produces the static frontend only; server runs TypeScript through tsx for local development. Package exports target workspace TypeScript sources; production server packaging is deferred.

`.env.example` documents local and eventual production settings. Vite loads frontend env files under apps/web; the server reads PORT from the process environment (for example `PORT=3001 npm run dev:server`). No environment file is needed for health-only defaults. Auth requires Google client/owner settings; the server runbook explains loading a root `.env`. Never put secrets in VITE_* variables or commit credentials or real player data.

## Layout and deployment

- apps/web: React/Vite static shell
- apps/server: Google sessions, private rooms, authoritative HTTP/WebSocket commands and durable storage adapters
- packages/game-engine: pure game rules, atomic turns, room/round models, golf scoring and tests ([API](docs/game-engine.md))
- packages/protocol: versioned Zod message schemas
- infra/azure: reserved for approved Pulumi work

No provisioning or deployment is included. GitHub Pages base path/custom domain, Azure deployment, durable storage and recovery procedures will be documented once approved and implemented. Local recovery uses private files; production requires the approved external Blob store. Live OAuth/Azure verification and TLS deployment remain pending.

## Validation status

Validation includes engine, protocol, cryptographic token checks, enrollment/session checks, room authorization/privacy, command idempotency/concurrency, failure injection, file-backed recovery and HTTP/WebSocket integration tests. Lint, strict typecheck, build and formatting are also checked. Live provider integration and browser playtests remain pending. The Phase 3 dependency installation reported zero audit findings.
