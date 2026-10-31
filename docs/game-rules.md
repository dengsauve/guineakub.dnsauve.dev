# Game rules — approved MVP rules

The owner approved the rules below in the decision walkthrough recorded in HUMAN-TODO.md. These rules are implemented in the pure engine. Enabled turn timers remain deferred until their behavior is decided; timers are off for MVP. Final display colors are still a creative decision.

| Topic               | Proposal / unresolved decision                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table               | Confirmed: one shared board, 2–8 players, each with a private rack                                                                                                                                  |
| 2–4 deck            | Approved: 2 copies of 4 colors × numbers 1–13 + 2 jokers = 106                                                                                                                                      |
| 5–6 deck            | Approved: 3 × 52 + 4 jokers = 160                                                                                                                                                                   |
| 7–8 deck            | Approved: 4 × 52 + 6 jokers = 214                                                                                                                                                                   |
| Initial rack        | Approved: 14 tiles per starting rack                                                                                                                                                                |
| Opening             | Approved: at least 30 points from rack-only melds first; jokers count as represented numbers; then board manipulation allowed that same turn                                                        |
| Groups              | Approved: 3–4 tiles of equal number, all distinct colors; duplicate copies of a color cannot share a group; jokers fill missing colors                                                              |
| Runs                | Approved: 3–13 consecutive numbers of one color; 1 is low only; no 13-to-1 wrapping; jokers fill missing positions                                                                                  |
| Jokers              | Retrieval and same-turn reuse approved below; movement approved below; remaining-rack joker value is 30 points                                                                                      |
| Drawing/passing     | Approved: optionally draw one instead of playing; drawing ends turn; no passing while bag has tiles. With an empty bag, play or pass; a full cycle of consecutive passes ends the round as blocked. |
| Board rearrangement | Approved: existing board tiles stay on board in valid melds; a submitted play adds at least one rack tile; opening sequence applies                                                                 |
| Endgame             | Approved: first empty rack wins; blocked rounds use lowest rack total with ties; disconnected players retain rack/order and are awaited on their turn                                               |
| Scoring             | Approved: cumulative scores across rounds; any player may reset tracking in the lobby. Golf scoring approved below; remaining jokers count as 30 points; blocked-round scoring approved below.      |
| Timer               | Approved: off by default; enabled-timer timeout behavior unresolved                                                                                                                                 |

## Implementation

Physical tile IDs distinguish copies. Approved player-count presets select the deck, while explicit deck creation remains available for fixtures. Seeded shuffle is only for reproducible tests; live setup must supply securely shuffled tiles and turn order. The engine validates melds, opening order, atomic proposed turns, joker movement, tile conservation, drawing/passing, round endings, cumulative scores and lobby score resets. See [engine API](game-engine.md).

## Approved joker retrieval rules

- Retrieval is allowed only after the player has completed their opening meld.
- Normally replace a joker with the numbered tile it represents, taken from your rack.
- In a three-tile group containing two numbered tiles and one joker, either missing color of the same number is an allowed replacement from your rack. The joker is not locked to one of those two colors. For example, red 2 + blue 2 + joker can accept either of the two other colors. Final color palette remains undecided; example colors are illustrative.
- Alternatively, remove a joker from a run by splitting the run at that joker, provided each remaining side is a valid run containing at least three tiles. No replacement tile is required for this allowance.
- Any retrieved joker must be reused in a valid meld in the same turn and may never be kept in the player's rack.

Multiple jokers are allowed in a single group or run, provided the meld is otherwise valid and contains at least one numbered tile. Melds made entirely of jokers are prohibited.

A joker may be rearranged within a meld and change its represented number in a run, or its represented color in a group. Its representation is not permanently fixed. The resulting meld must be valid.

A joker may move to another meld if its removal leaves behind one valid meld, or two valid melds formed by splitting its original run. It may not leave an invalid remnant. Rack replacement is one way to preserve validity, but is not required when removal itself leaves valid meld(s). Each split side must contain at least three tiles. The moved joker must be used in a valid meld during the same turn; the post-opening restriction still applies.

Joker movement and retrieval rules are approved. Each joker remaining in a rack scores 30 points under the approved golf scoring rules.

## Approved opening sequence

Each player starts with 14 tiles. On their opening turn, they must first lay down valid melds totaling at least 30 points using only tiles from their own rack. Jokers contribute the number they represent. Existing board tiles cannot contribute to those 30 points.

After satisfying that opening requirement, the player may manipulate existing melds during the same turn, including using the approved joker rules. The server must validate that the rack-only opening was completed before board manipulation, even though the whole turn commits atomically. An explicit opening step in the proposed turn proves this ordering before subsequent board edits.

Turn timers are off by default. Behavior when timers are enabled remains unresolved.

## Approved drawing rules

A player may choose to draw instead of playing, even when a legal move is available. Draw exactly one tile; this ends the turn, and the drawn tile cannot be played until a later turn. Passing without drawing is not allowed while the bag contains tiles. When the bag is empty, players may play or pass. A successful play resets the consecutive-pass count. If every player passes consecutively, the round ends as blocked. In a blocked round, everyone adds their remaining rack points; the lowest rack total wins the round, with ties allowed.

## Approved score tracking

Track cumulative player scores across rounds. Provide a score-reset button in the lobby, available to every player (not restricted to the host). Reset clears the accumulated score tracking. Use golf scoring: lowest cumulative score is best. The first player to empty their rack wins the round and adds zero points. Every other player adds points equal to the tiles remaining in their rack, with numbered tiles counted at face value. There is no transfer of points to the winner.

Each joker remaining in a rack counts as 30 points. In a blocked round, every player adds their remaining rack points (including the round winner). The player with the lowest remaining rack total wins the round; equal lowest totals are a tie.

## Approved turn submission and reset

Every tile already on the committed board must remain on the board in valid melds. A submitted play must add at least one tile from the current player's rack; rearrangement alone is not a completed play. Opening requirements and joker movement rules still apply.

An invalid submission changes no committed state. Reset Turn discards the local draft and restores the committed board and the player's committed rack.

## Approved player order

Randomize the full player turn order at the start of each round. The first player in that order starts. The frontend should reveal the resulting order with a fun animation; the server determines the order, and the animation presents that committed result. Provide a reduced-motion alternative.

## Approved disconnect behavior

Disconnected players retain their rack and position in turn order. Other players may continue their turns normally; if the disconnected player's turn arrives, wait for them to reconnect. Do not automatically draw, skip, pass or forfeit for a disconnected player. Reconnection restores their committed state. Timer-enabled behavior, if implemented later, must not silently override this policy.
