import { expect, it } from "vitest";
import {
  applyRoundCommand,
  assertRoundInventory,
  createTestRound,
  validateMeld,
  type Placement,
  type ProposedMeld,
  type RoundState,
  type Tile,
} from "./index";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function findPlay(state: RoundState): ProposedMeld | null {
  const rack = state.players[state.turnIndex]!.rack;
  const numbered = rack.filter(
    (tile): tile is Extract<Tile, { kind: "number" }> => tile.kind === "number",
  );
  const catalog = new Map(state.deck.map((tile) => [tile.id, tile]));
  for (let a = 0; a < numbered.length; a++)
    for (let b = a + 1; b < numbered.length; b++)
      for (let c = b + 1; c < numbered.length; c++) {
        const tiles: Placement[] = [numbered[a]!, numbered[b]!, numbered[c]!]
          .map((tile) => ({
            tileId: tile.id,
            color: tile.color,
            value: tile.value,
          }))
          .sort((a, b) => a.value - b.value);
        const meld: ProposedMeld = {
          id: `r${state.revision}`,
          kind: tiles[0]!.value === tiles[2]!.value ? "group" : "run",
          tiles,
        };
        const validation = validateMeld(meld, catalog);
        if (
          validation.ok &&
          (state.players[state.turnIndex]!.opened || validation.points >= 30)
        )
          return meld;
      }
  return null;
}
it.each([2, 4, 6, 8])(
  "simulates legal plays/draws/passes for %i players over multiple seeds with frozen inputs",
  (count) => {
    for (let seed = 0; seed < 4; seed++) {
      let state = createTestRound(
        Array.from({ length: count }, (_, i) => `p${i}`),
        seed,
        seed + 10,
      );
      let turns = 0;
      while (!state.result && turns < 500) {
        const player = state.players[state.turnIndex]!;
        const meld = findPlay(state);
        const common = {
          playerId: player.id,
          expectedRevision: state.revision,
        };
        const command = meld
          ? {
              ...common,
              type: "play" as const,
              steps: [
                {
                  type: player.opened ? ("lay" as const) : ("open" as const),
                  melds: [meld],
                },
              ],
            }
          : {
              ...common,
              type: state.bag.length ? ("draw" as const) : ("pass" as const),
            };
        const before = structuredClone(state);
        const result = applyRoundCommand(freeze(state), freeze(command));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error(result.code);
        expect(state).toEqual(before);
        expect(result.state.revision).toBe(state.revision + 1);
        assertRoundInventory(result.state);
        state = result.state;
        turns++;
      }
      expect(turns).toBeLessThan(500);
      expect(state.result).not.toBeNull();
      expect(state.result!.winners.length).toBeGreaterThan(0);
      expect(
        Object.values(state.result!.points).every((points) => points >= 0),
      ).toBe(true);
    }
  },
);
