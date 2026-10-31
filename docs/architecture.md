# Architecture and trust boundaries

React/Vite is a static client intended for GitHub Pages. A single Node HTTP/WebSocket server will be authoritative. Pure engine code has no network/UI/cloud dependencies. Shared Zod schemas define protocol-v2 authenticated room messages. The server implements identity, sessions, room control, filtered state and conditional storage adapters; live provider verification and the frontend remain pending. See [server runbook](server.md).

## Target command flow

1. Google Identity Services returns an ID token to the client. Backend verifies signature, issuer, audience and expiry, checks stable Google `sub` allowlist, then issues its own session credential. Enrollment and host behavior are approved below; the server uses host-only HttpOnly cookies with a 12-hour expiry and exact-origin checks.
2. Authenticated room members fetch viewer-filtered snapshots. Only the viewer's rack is included; other racks expose counts and the bag exposes only its count.
3. Client edits an untrusted local turn draft. Reset discards the draft; it does not change committed server state.
4. Commands include a protocol version, command ID and expected revision. Server checks identity, membership, turn ownership, ownership of played tiles and engine legality.
5. Persist the accepted revision and idempotency result atomically before acknowledging or broadcasting filtered updates. Serialize commands per room. Duplicate IDs return the recorded outcome; reused IDs with different payloads fail. Stale revisions fail without mutation.
6. Reconnection reauthenticates and requests the latest filtered snapshot. Restart loads durable snapshots; no game depends on container disk or process memory.

## Persistence — approved for implementation

[Storage decision](storage-decision.md) compares Blob and Table Storage and records current Microsoft retail API rates, cost assumptions, consistency, access controls, retention and recovery scope. Recommend Standard Hot LRS block blobs in a StorageV2 account, one conditional snapshot plus receipts per room, and managed identity access. The illustrative storage-only cost is about $0.08/month, with a target below $1/month at the stated workload. Owner approved this design for implementation; no resources have been provisioned.

Container Apps Consumption free grants do not establish a zero-cost guarantee for the application. Compute, registry, logs and networking require a separate deployment estimate. Confirm region/subscription pricing, cold starts, WebSocket behavior and idle scaling before provisioning.

## Domains and operations

Use separate frontend and API hostnames (owner selection pending). GitHub Pages serves static assets; Azure serves HTTPS and WSS. Cloudflare DNS/proxy choice is pending. Configure explicit allowed frontend origins and authenticated upgrades before exposing game endpoints. Local development binds loopback; production requires explicit auth/storage/origin configuration behind HTTPS ingress. The cookie design requires same-site frontend/API hostnames.

Future deployment requires Pulumi, TLS/domain configuration, secret-store setup and explicit owner approval. Recovery will restore a versioned private snapshot, validate schema/tile conservation and resume at the persisted revision; local recovery tests are implemented, while live Azure recovery drills remain outstanding.

## Owner decisions for room lifecycle

Every approved family member may create/host a room. Room joining supports both private links and short codes, with approved Google sign-in required and no guest access. Hosts may remove players in the lobby and abandon an active round, returning everyone to the lobby without adding that round's scores.

The owner requested no saved rooms. Do not implement saved-room browsing or manual resume of past/abandoned rooms. Rooms are temporary for each game night, but active games must survive browser refreshes, reconnects and server restarts. External durable recovery remains required. Expire the room and its cumulative scores 24 hours after everyone disconnects. Reconnection before expiration cancels that pending expiration; a later transition to everyone disconnected starts a new 24-hour window. The host may close the room sooner with an End Game Night control. Expiration/closure prevents further room resume or joining.

## Approved family enrollment

The project owner is the family-account administrator. A new user signs in with Google and waits for owner approval before creating or joining rooms. Approval binds to the backend-verified stable Google `sub`, never a display name. A room invitation is not family-account approval.

Bootstrap the owner's administrator identity through trusted server configuration using their verified Google `sub`; never make the first public sign-in an administrator. Secure owner bootstrap/account setup remains an implementation/setup task. Do not request passwords or credentials in chat.

## Approved host continuity

Keep the original host identity separate from the current acting host. When the original host disconnects, automatically transfer host controls to another connected room member. Restore controls to the original host when they reconnect. Temporary hosting does not change game turn order or skip a disconnected player's turn. Choose any eligible connected room member using a simple implementation; no join-order tracking or selection-order guarantee is required. If the acting host disconnects, choose another connected member.
