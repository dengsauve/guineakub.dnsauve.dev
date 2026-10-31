# HUMAN-TODO.md — Guineakub (project owner)

> These are choices, approvals and account actions for the human. Codex should ask rather than guess. Never paste credentials into chat or commit them to Git.

## First: confirm the game

- [x] Confirm **one shared board with up to 8 simultaneous players** (rather than two 4-player tables).
- [x] Approve deck compositions: 2 numbered copies + 2 jokers = 106 tiles (2–4 players); 3 copies + 4 jokers = 160 (5–6); 4 copies + 6 jokers = 214 (7–8).
- [x] Approve joker movement/retrieval rules: removal must leave one valid meld or two valid split runs; rack replacement and flexible missing-color replacement are allowed; retrieved jokers must be reused that turn after opening. Multiple jokers and changing representation within a meld are allowed; every meld must contain at least one numbered tile. See docs/game-rules.md; remaining jokers score 30 points under the approved golf scoring.
- [x] Confirm 30-point rack-only opening, 14-tile racks and timers off by default. Jokers count as represented numbers; board manipulation is allowed during the opening turn only after meeting the opening threshold.
- [x] Approve drawing: may draw instead of playing even with a legal move; draw one and end turn; no passing while bag contains tiles.
- [x] Approve empty-bag passing: play or pass; successful play resets consecutive passes; one full cycle of consecutive passes ends the round as blocked. Blocked-round scoring is approved below.
- [x] Track scores across rounds; every player can reset the score tracking with a button in the lobby.
- [x] Approve golf scoring: first to empty their rack wins and adds zero; others add remaining rack points; lowest cumulative total is best.
- [x] Value each joker remaining in a rack at 30 points.
- [x] Randomize the full turn order at the start of each round; first in order starts. Reveal the order with a fun frontend animation.
- [x] Disconnected players retain rack and turn order; wait if their turn arrives until they reconnect. No automatic draw, skip or forfeiture.
- [x] Approve groups of 3–4 equal numbers in distinct colors, with no duplicate color; runs of 3–13 consecutive numbers of one color, 1 low only and no wrapping. Jokers fill missing positions while preserving those rules.
- [x] Approve blocked-round scoring: everyone adds remaining rack points; lowest rack total wins the round, with equal lowest totals tied.
- [x] Approve turn constraints: all committed board tiles remain on board in valid melds; each submitted play adds at least one rack tile; invalid submissions change nothing; Reset Turn restores the committed board/rack in the local draft.
- [x] Confirm all players have Google accounts; require Google sign-in for MVP, with no guest access.

## Accounts, DNS and infrastructure

- [ ] Choose and create the GitHub repository (suggested: `guineakub`); authorize Codex to work in it.
- [ ] Choose same-site HTTPS domain/subdomains (example: `play.example.com` and `api.example.com`) for production cookie authentication. Unrelated free provider hostnames require an authentication transport redesign.
- [ ] Confirm Cloudflare is the intended DNS provider (not AWS CloudFront).
- [ ] Choose an Azure subscription and verify Container Apps Consumption availability, free grants, billing and spending alerts.
- [x] Approve the documented Standard Hot LRS Blob Storage recommendation and storage-only target below $1/month (illustrative $0.08/month); see docs/storage-decision.md for assumptions, latest-state-only recovery and cleanup behavior. Provisioning requires separate approval.
- [ ] Create a Google Cloud OAuth client with authorized web origins; configure approved domains/redirects as required by the chosen flow.
- [ ] Configure deployment credentials, GitHub Actions secrets and Azure/Google environment settings through secure secret stores.
- [ ] Approve any cloud resource creation, DNS change or production deployment before Codex executes it.

## Family onboarding

- [x] Every approved family member can join games and create/host rooms.
- [x] Owner is the administrator: new users sign in with Google, then await owner approval before creating or joining rooms. Bind approvals to verified Google `sub` identifiers; never collect passwords.
- [ ] Securely configure the owner’s verified Google `sub` as the initial administrator; do not use first-sign-in auto-admin enrollment.
- [x] Support both shareable private room links and short codes. Joining still requires an approved Google account.
- [x] Hosts may remove players in the lobby and abandon an active round, returning everyone to the lobby without scoring that round.
- [x] Do not offer saved-room browsing or manual resume of past/abandoned rooms.
- [x] Rooms are temporary for each game night; active games still survive refreshes, reconnects and server restarts through durable recovery.
- [x] Expire the room and its cumulative scores 24 hours after everyone disconnects. Host may close it sooner with End Game Night.
- [x] Automatically transfer host controls to another connected player when the original host disconnects; restore controls to the original host when they reconnect.
- [x] Temporary-host selection is implementation-defined among connected room members; no join-order tracking or ordering guarantee is needed.

## Guinea pig creative direction

- [ ] Approve the **Guineakub** name and original guinea pig joker art direction.
- [ ] Decide whether the two jokers have distinct characters (e.g., Distinguished Gentleman and Chaos Potato).
- [ ] Supply original artwork or approve commissioning/generating it; confirm rights to use it.
- [ ] Pick a simple visual theme and ensure joker art is recognizable at tile size.

## Testing and launch

- [ ] Test from at least one desktop and one phone/tablet.
- [ ] Recruit family members for a full 8-player playtest.
- [ ] Check whether dragging tiles and rearranging a crowded board feels natural.
- [ ] Approve final house rules, onboarding instructions and MVP release.
- [ ] Review any recurring cloud charges after the first game night.

## Decisions log

| Decision        | Status    | Notes                                               |
| --------------- | --------- | --------------------------------------------------- |
| Project name    | Confirmed | Guineakub                                           |
| Joker theme     | Confirmed | Guinea pig art                                      |
| Frontend        | Planned   | GitHub Pages                                        |
| Backend         | Planned   | Azure Container Apps Consumption                    |
| DNS             | Proposed  | Cloudflare (not CloudFront)                         |
| Authentication  | Confirmed | Google sign-in required; no MVP guests              |
| Max players     | Confirmed | 2–8 players on one shared board, with private racks |
| 7–8 player deck | Confirmed | Approved: 4 × 52 + 6 jokers = 214 tiles             |
| Persistence     | Approved  | Standard Hot LRS Blob Storage; implementation only  |
