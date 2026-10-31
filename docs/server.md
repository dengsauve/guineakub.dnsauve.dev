# Server, sessions and local recovery

Phase 3 implements the HTTP/WebSocket service and durable-storage boundary. It does not provision Azure, configure OAuth, deploy a server or build the Phase 4 UI. Read [architecture](architecture.md), [storage decision](storage-decision.md) and the human checklist for account/deployment setup.

## Local setup

Use Node 22.13+ (22.x), 24.x or 26+ and run `npm ci` from the root. The server development command runs TypeScript with tsx. To load a root `.env`, copy `.env.example` to `.env`, edit it locally, then from the root run:

```sh
node --env-file=.env --import tsx apps/server/src/index.ts
```

Alternatively export the variables in your shell and run `npm run dev:server` for watch mode. That command inherits the environment; it does not automatically load `.env`. Local defaults bind only `127.0.0.1:3000`. The executable uses a private single-process FileStore under `SERVER_DATA_DIR` (default `.local-data` relative to the working directory). Use a fixed absolute path if switching between root and workspace commands. Local snapshots, account approvals and hashed sessions survive a server restart. They are ignored by Git and written with restricted file permissions. Never copy real family data into tests or commit it.

If Google settings are missing, `/health` is available, `/ready` reports 503, and all auth/game access fails closed. There is no development-login bypass in the executable. Tests inject a verifier through the application factory only.

Required for real Google login:

- `GOOGLE_CLIENT_ID`: the Google OAuth web client audience configured for the actual frontend origins.
- `ADMIN_GOOGLE_SUB`: the owner's verified stable Google subject, securely configured on the server. Obtain it using a trusted local verification/onboarding setup; do not paste ID tokens or credentials into chat. The first public user never becomes administrator automatically.
- `ALLOWED_ORIGINS`: exact comma-separated frontend origins, no wildcard. Local examples are in `.env.example`.

Use `NODE_ENV=production` only behind configured Azure HTTPS/WSS ingress. Production requires both auth settings, explicit HTTPS origins, `AZURE_STORAGE_ACCOUNT_URL` and `AZURE_STORAGE_CONTAINER`. It refuses the filesystem fallback. The Azure account/container and managed-identity role must already exist from separately approved provisioning. Do not set an account key or put credentials into the frontend. Container private access, Shared Key restrictions and role scope are deployment checks, not changes performed by this service.

## Sign-in and enrollment contract

1. From the allowed frontend, fetch `GET /auth/nonce` with `credentials: 'include'`. The response contains a nonce and sets a five-minute HttpOnly challenge cookie.
2. Initialize Google Identity Services with that nonce. Send the returned ID token as JSON `{ credential }` to `POST /auth/google`, also with credentials included. A one-use challenge binds the Google response to this browser's sign-in attempt. The backend checks signature, audience, issuer, expiry and nonce using Google's supported verification library and explicit claim checks. See [Google verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
3. The server sets an opaque, host-only, HttpOnly session cookie. Production adds `Secure` and the `__Host-` prefix. Session lifetime is 12 hours, with no sliding extension. Reauthenticate with Google after expiry; no passwords or Google refresh tokens are stored. Only a SHA-256 hash of the random session credential is persisted, alongside user ID and expiry.
4. `GET /auth/me` reports the opaque user ID, display name, pending/approved state, admin state and session expiry. A pending user cannot connect to game WebSockets, create or join rooms.
5. The configured owner can `GET /admin/accounts` and `POST /admin/approve` with `{ uid }`. Approval is bound internally to the verified Google subject; display names never authorize a user. Google subjects are not exposed to other players.
6. `POST /auth/logout` deletes the session and closes sockets using it. Sessions and family approvals survive process restarts. Expired sessions are physically cleaned on maintenance; their timestamps prevent authentication even before cleanup.

Cookie mode is `SameSite=Lax`. Production frontend/API must therefore use same-site HTTPS hostnames, for example `play.example.com` and `api.example.com`. Unrelated default GitHub Pages and Azure hostnames are not a supported sign-in arrangement for this cookie design. Domain choice remains on the human checklist. Every credentialed endpoint and WebSocket upgrade checks the exact allowed Origin, and JSON-only POSTs prevent accepting browser form submissions. There is no token in a WebSocket URL. Local clients must consistently use localhost or 127.0.0.1 for cookies.

## WebSocket protocol v2

Connect to `/ws` from the allowed origin after approval, using the session cookie. Protocol v1 liveness-only messages are no longer accepted. All messages include `{ version: 2, requestId }`; the shared protocol package contains strict Zod schemas, including bounded tile proposals.

| Message type     | Additional fields                                   | Behavior                                                                                      |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ping`           | none                                                | `pong`, with request correlation                                                              |
| `create-room`    | none                                                | Persist room, subscribe, return private `snapshot`; request ID makes creation retryable       |
| `join-code`      | `code`                                              | Join by eight-character code, then subscribe                                                  |
| `join-link`      | `roomId`, `token`                                   | Join by private link components, then subscribe                                               |
| `subscribe-room` | `roomId`                                            | Reconnect an existing member without needing the invitation again                             |
| `room-command`   | `roomId`, `commandId`, `expectedRevision`, `action` | Validate, persist receipt/state atomically, then acknowledge and broadcast filtered snapshots |

Each socket subscribes to one room; additional rooms can use separate sockets. One account may have multiple sockets/tabs. A member counts as connected while at least one of their room sockets remains connected. New membership is lobby-only and capped at eight; existing members can reconnect during play. Create is limited to five nonexpired rooms per creator to bound accidental resource use.

Room actions are `start`, `abandon`, `end`, `remove-player`, `reset-scores`, `draw`, `pass` or `play`. `remove-player` includes the opaque player ID. Game actions include `expectedRoundRevision`; `play` also includes the ordered engine proof steps described in [the engine API](game-engine.md). Actor identity always comes from the verified session; clients cannot submit another player's identity or authoritative state.

The current acting host may start, abandon, end or remove another player in the lobby. Removal does not eject the original host or the acting host themselves; the original-host identity remains the stable reversion anchor. The original host regains controls on reconnect. Temporary selection uses whichever eligible connected member is convenient; no join-time ordering is stored. Removing someone is not a permanent account ban: an approved person with the invitation can rejoin during the lobby. Abandon discards the active round without adding its points. Any member may reset scores in the lobby. End Game Night closes the room immediately; there is no reopen or saved-room browsing.

Server outputs are strictly validated `snapshot`, `ack`, `error`, `pong` or `room-closed` messages. Only the viewer's rack is included; other players have counts, and the bag has a count. No full deck/order, account registry, session credential or command ledger is sent. Invitations are shared only with room members. Repeated command IDs return their recorded revision without applying again; reusing an ID with a different payload fails. A current filtered snapshot follows an acknowledgment, so the client must use snapshot revisions and never treat an old duplicate acknowledgment as current board state.

## Durable commits and failure handling

The server serializes each room's commands and presence updates. The room document includes revision, engine state, scores, original/acting host, members, invitation material, expiry and command receipts. A conditional write atomically stores both the accepted change and receipt before any success/broadcast. On an ambiguous response, read back the candidate before returning success. Conflicts or unavailable storage never cause an in-memory-only accepted turn.

The latest accepted snapshot is authoritative. On startup, strict schemas, membership, deck conservation and meld/result invariants are checked before serving rooms. An unknown/corrupt snapshot blocks startup with a generic error; do not delete it to make the server appear healthy. The service prints structured event/error codes only, without request bodies, credentials or snapshots.

Azure writes use create-only/ETag conditions and a single full-blob upload, per the [Azure conditional-request API](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/blobrequestconditions?view=azure-node-latest). The adapter never creates its container. Snapshots are limited to 8 MiB; receipts are limited to 20,000 per room. If a bound is reached, fail without mutation instead of silently dropping deduplication history. End Game Night may still close a room and discard its game-night history.

## Presence, expiration and operational recovery

WebSocket ping/pong runs every 15 seconds; a missing pong by the next check terminates the socket. Sessions are checked on every application message and expired sessions are disconnected by heartbeat. No game draw, pass or skip is generated by disconnection. If it is the absent player's turn, play waits.

Persist presence boundaries and a liveness checkpoint at most once per minute per connected room, not every heartbeat. A graceful last disconnect starts the 24-hour deadline. A crash may bypass close handlers: startup treats everyone as disconnected and anchors expiry to the last checkpoint plus 24 hours. That crash boundary is approximate by up to the checkpoint interval (plus failure-detection delay); restarting again never renews it. Reconnect before expiry cancels the deadline. Logical expiry is checked before access; physical cleanup runs each minute while awake and at startup. A scaled-to-zero app may retain inaccessible expired objects until its next wake. Family approvals outlive room expiration.

Recovery procedure:

1. Restore storage connectivity/managed-identity permissions if unavailable. Do not acknowledge queued mutations until conditional writes work.
2. Restart exactly one server instance against the same store. Do not mix multiple local FileStore processes.
3. Reauthenticate the player and subscribe to the same room ID. Serve the validated current revision and their private rack. Retry an unacknowledged command with its original command ID and payload.
4. If a snapshot is corrupt, stop and inspect it through authorized tooling without logging private content. MVP has no historical backups; operator deletion or corruption may be unrecoverable. Never fabricate a replacement state under the same active room ID.

## Validation and remaining live setup

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check`. Network integration tests bind temporary loopback ports and may need sandbox approval. They inject synthetic identities and do not contact Google or Azure. Google verification tests use real RSA signatures with injected local public certificates. Azure contract tests check conditional-write headers and error handling with a simulated SDK client. File-backed recovery tests create a new store/service instance; network recovery tests create a new HTTP/WebSocket server instance.

Live Google GIS/browser verification, real Azure conditional-write/managed-identity/restart smoke tests, production ingress/TLS and the Phase 4 frontend remain unverified until the human configures OAuth, owner identity, same-site domains and approved Azure resources. These configuration tasks are not marked complete. HTTP/readiness and heartbeat/capacity behavior must also be exercised behind the eventual Azure proxy; forwarded IPs are currently not trusted for rate limiting.
