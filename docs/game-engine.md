# Pure game engine API

`packages/game-engine` has no React, network, random-system-source or Azure dependencies. It uses readonly models and pure operations; failures never mutate committed state. The public API is exported from `src/index.ts`.

## Setup and randomness

`deckConfigForPlayers(count)` returns the approved 106/160/214 composition for 2–4/5–6/7–8 players. `createDeck` makes uniquely identified physical tiles. Internal color identifiers (`red`, `blue`, `black`, `orange`) are placeholders, not a final display palette.

`dealRound(playerOrder, shuffledDeck)` validates membership and the complete physical deck, then deals 14 tiles per player, one per player per dealing pass. It preserves the supplied player order; the first player starts. The live server must use secure randomness to shuffle both order and deck before calling it. No security RNG or secretly shared production seed is implemented in this package. `createTestRound(ids, deckSeed, orderSeed)` and `seededShuffle` are explicitly deterministic test/simulation utilities.

The entire `RoundState`, including its initial deck order, bag and every rack, is private authoritative data. Never serialize it directly to a client. Phase 3 must provide per-viewer snapshots and authenticated command routing.

## Meld proposals

A `ProposedMeld` contains a unique board-local `id`, `kind` (`group` or `run`), and placements `{ tileId, color, value }`. The server resolves physical tile IDs against its canonical catalog. A numbered tile cannot change number or color. A joker's assignment belongs to the placement and can change according to the approved rules. Runs are represented in ascending order; group order is arbitrary. Final display colors can map these internal identifiers to accessible artwork later.

`validateMeld` returns `{ ok: true, points }` or `{ ok: false, code }`. `validateBoard` also rejects duplicate physical tile IDs or meld IDs across melds. Every meld needs at least one numbered tile. `assertRoundInventory` checks canonical deck composition, metadata, meld validity and exact physical conservation across board, racks and bag.

## Atomic turn proposals

`applyRoundCommand(state, command)` accepts `playerId`, `expectedRevision`, and one of `play`, `draw`, or `pass`. A successful result contains a detached candidate state at the next revision. An invalid command returns an error code and no candidate. The caller still owns the unchanged committed state. It must persist a candidate successfully before acknowledging or broadcasting it.

A `play` contains ordered `TurnStep`s:

- `open`: add rack-only melds worth at least 30 in total. This must precede board manipulation by a player who has not opened. Jokers count by representation.
- `lay`: add valid melds using rack tiles and/or board tiles temporarily held by an earlier release step.
- `rearrange`: replace the specified source melds with valid melds, retaining all source physical tiles and optionally adding rack/held tiles. Number-only melds can be freely recombined. An existing board joker must remain together with its entire source tile group in an output meld, including whole-meld merges, unless first released or split by another step. This prevents relabeling a meld to bypass retrieval validation. Retained jokers may change representation.
- `split-run`: partition a run into two or more contiguous valid runs, preserving all physical tiles and their order. A joker can remain in its original segment without being retrieved.
- `retrieve-joker`: remove a board joker while providing one valid remnant, or the two valid runs on its original sides. An optional numbered replacement must come from the rack and satisfy the replacement rule. Only the source tiles plus that optional replacement may appear in these remnants. The released joker must be used by a later step that turn.
- `detach-numbered`: the analogous proof step for moving a numbered board tile out of a meld while leaving valid remnants, including a meld with retained jokers. The detached tile must be reused on the board in that same turn. This facilitates legal rearrangements without claiming a joker was freely extracted.

These steps are a validation proof, not UI interactions: the frontend may let a draft be temporarily invalid while dragging, then construct valid proposal steps for submission. Each proof stage must have valid committed-board candidates. Held board tiles are accounted for in conservation checks and cannot be added to the player's rack. Every complete play must add at least one original rack tile. Any failed stage rolls back the entire proposal, including earlier valid opening or retrieval steps.

`resetTurnDraft(state, playerId)` returns detached board/rack copies at the committed revision, without changing that revision. It is a local draft helper, not a server state transition.

Drawing takes one tile and ends the turn. Passing is allowed only with an empty bag. Successful plays reset consecutive passes. A full cycle of consecutive passes finishes a blocked round. The engine has no automatic clocks, skips or forfeits, so an absent current player is awaited; the server handles authenticated reconnection and presence.

## Round results, rooms and score resets

An empty rack ends the round with one winner. A blocked round names the lowest remaining rack total, allowing ties. `rackPoints` values numbered tiles at face value and jokers at 30. `scoreRound` calculates positive golf penalties for every remaining rack, with no transfer to the winner.

`createGameRoom(id, playerIds)` creates a pure fixed-membership game container for 2–8 players. Server lobby/invitation membership is separate. `startRoomRound` accepts a room revision and securely shuffled order/deck; it starts only before/between rounds and keeps cumulative scores. Server host permissions remain a Phase 3 decision.

`applyRoomCommand(room, expectedRoomRevision, command)` wraps round commands and applies each completed round's points once. Each accepted room mutation increments the room revision; round revisions start at zero each round. The room revision must come from the submitted command envelope to reject cross-round stale commands. `resetRoomScores(room, memberId, expectedRevision)` allows any member to zero cumulative scores in the lobby (no active round). The frontend reset button and order animation remain Phase 4 work.

Revision rejection prevents repeated application against a newer state, but it is not command-ID idempotency. Phase 3 must validate untrusted messages with Zod, bind player identity to verified sessions, deduplicate command IDs, serialize room writes, persist before success and return viewer-filtered responses. Engine types assume structurally valid TypeScript input; they are not a network parsing layer. Invalid setup/lobby operations throw; invalid round commands return typed errors.

## Validation

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check` from the repository root. Tests cover approved deck compositions, dealing and reproducibility across seeds, exhaustive run intervals/joker positions, groups, opening boundaries, same-turn manipulation, joker exceptions, ownership, conservation, frozen inputs, atomic rollback, stale revisions, reset drafts, scoring and lobby resets. Simulations run at 2/4/6/8 players; they exercise a subset of legal choices and do not claim strategy coverage or replace browser/network acceptance tests.
