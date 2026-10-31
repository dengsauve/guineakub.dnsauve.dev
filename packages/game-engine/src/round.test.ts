import { describe, expect, it } from "vitest";
import {
  createDeck,
  createTestRound,
  dealRound,
  deckConfigForPlayers,
  assertRoundInventory,
  rackPoints,
  scoreRound,
  type RoundPlayer,
} from "./index";
it.each([
  [2, 106],
  [3, 106],
  [4, 106],
  [5, 160],
  [6, 160],
  [7, 214],
  [8, 214],
])("deals approved %i-player deck (%i tiles) over 30 seeds", (count, size) => {
  for (let seed = 0; seed < 30; seed++) {
    const ids = Array.from({ length: count }, (_, i) => `p${i}`);
    const state = createTestRound(ids, seed, seed + 100);
    expect(state.deck).toHaveLength(size);
    expect(state.bag).toHaveLength(size - count * 14);
    expect(state.players.every((p) => p.rack.length === 14 && !p.opened)).toBe(
      true,
    );
    expect(new Set(state.players.map((p) => p.id))).toEqual(new Set(ids));
    expect(state.revision).toBe(0);
    expect(state.turnIndex).toBe(0);
    expect(state.result).toBeNull();
    expect(() => assertRoundInventory(state)).not.toThrow();
    expect(state).toEqual(createTestRound(ids, seed, seed + 100));
  }
});
it("randomizes player order independently from the deck seed", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const a = createTestRound(ids, 1, 2);
  const b = createTestRound(ids, 1, 3);
  expect(a.deck).toEqual(b.deck);
  expect(a.players.map((p) => p.id)).not.toEqual(b.players.map((p) => p.id));
  expect(ids).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
});
it("rejects invalid player counts/IDs and altered, duplicate or wrong-size decks", () => {
  for (const count of [0, 1, 9, 2.5, NaN])
    expect(() => deckConfigForPlayers(count)).toThrow();
  const deck = createDeck(deckConfigForPlayers(2));
  expect(() => dealRound(["a", "a"], deck)).toThrow();
  expect(() => dealRound(["a", ""], deck)).toThrow();
  expect(() => dealRound(["a", "b"], deck.slice(1))).toThrow();
  expect(() => dealRound(["a", "b"], [...deck.slice(1), deck[1]!])).toThrow();
  expect(() =>
    dealRound(["a", "b"], createDeck(deckConfigForPlayers(8))),
  ).toThrow();
});
it("does not alias caller tile objects or player order", () => {
  const deck = createDeck(deckConfigForPlayers(2));
  const ids = ["a", "b"];
  const state = dealRound(ids, deck);
  ids[0] = "changed";
  Object.assign(deck[0]!, { id: "changed" });
  expect(state.players[0]!.id).toBe("a");
  expect(state.deck[0]!.id).not.toBe("changed");
});
describe("golf scores", () => {
  const deck = createDeck(deckConfigForPlayers(2));
  const tile = (id: string) => deck.find((t) => t.id === id)!;
  const players: RoundPlayer[] = [
    { id: "winner", rack: [], opened: true },
    {
      id: "other",
      rack: [tile("number:1:red:13"), tile("joker:1")],
      opened: false,
    },
  ];
  it("values remaining numbered tiles and jokers, with no transfer", () => {
    expect(rackPoints(players[1]!.rack)).toBe(43);
    expect(scoreRound(players, "empty-rack")).toEqual({
      reason: "empty-rack",
      winners: ["winner"],
      points: { winner: 0, other: 43 },
    });
  });
  it("scores every rack in blocked rounds and allows equal minimums", () => {
    const tied = players.map((p) => ({ ...p, rack: [tile("number:1:red:2")] }));
    expect(scoreRound(tied, "blocked")).toEqual({
      reason: "blocked",
      winners: ["winner", "other"],
      points: { winner: 2, other: 2 },
    });
    expect(() => scoreRound(tied, "empty-rack")).toThrow();
  });
});
