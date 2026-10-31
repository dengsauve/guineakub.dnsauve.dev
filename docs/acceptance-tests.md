# Acceptance test specification

These scenarios are planned, not executed. Gameplay expectations follow the approved rules in game-rules.md.

Run the full matrix at 2, 4, 6 and 8 authenticated players in one room. Use the approved deck composition for each count. Check room capacity, unique physical tile IDs, approved rack sizes, conservation, shared board and consistent turn order after each accepted action. For 6 and 8 players explicitly exercise repeated numbered copies and every joker.

For each size:

- Opening just below/at threshold; legal/illegal group and run; approved joker replacement; complete board rearrangement; rack empty and approved empty-bag ending.
- Reset a local draft; reject an invalid atomic submission with byte-equivalent committed state and unchanged revision.
- Concurrent submissions with equal expected revision: at most one accepted transition. Retries of one command ID cause no additional draw or revision. Same ID/different payload rejected.
- Reject unauthenticated, nonmember, wrong-turn and stolen-tile commands. Inspect every viewer snapshot/event to prove no other rack contents or bag order leak.
- Refresh/reconnect all clients and compare their own racks and shared committed state. Disconnect the current player and apply the approved policy.
- Restart after durable commit but before acknowledgment; reconnect/retry and recover one accepted transition. Simulate storage failure before commit and verify no success acknowledgment or broadcast.
- Exercise keyboard, touch and desktop interactions; test board navigation with crowded 8-player layouts. Record browser/device and latency; targets require playtesting.

Current automated tests cover deck presets, shuffle/deal, group/run and joker validation, ordered opening proof, atomic turns, ownership, conservation, revision conflicts, draft reset, drawing/passing, blocked and empty-rack scoring, room score accumulation/reset, and generated/frozen-input simulations for 2/4/6/8 players. Protocol tests cover liveness validation. These pure tests do not constitute networked multiplayer acceptance; authentication, viewer filtering, persistence recovery and real browsers remain pending.
