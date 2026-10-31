import { expect, it } from "vitest";
import {
  COLORS,
  createDeck,
  seededShuffle,
  assertTileConservation,
  type TileInventory,
} from "./index";
it.each([
  [2, 2, 106],
  [3, 4, 160],
  [4, 6, 214],
])(
  "creates explicit composition %i/%i (%i tiles), with unique physical copies",
  (numberedCopies, jokers, total) => {
    const deck = createDeck({ numberedCopies, jokers });
    expect(deck).toHaveLength(total);
    expect(new Set(deck.map((t) => t.id)).size).toBe(total);
    expect(deck.filter((t) => t.kind === "joker")).toHaveLength(jokers);
    for (const color of COLORS)
      for (let value = 1; value <= 13; value++)
        expect(
          deck.filter(
            (t) =>
              t.kind === "number" && t.color === color && t.value === value,
          ),
        ).toHaveLength(numberedCopies);
  },
);
it("rejects invalid composition and seeds", () => {
  for (const value of [-1, 1.5, NaN, Infinity, 9]) {
    expect(() => createDeck({ numberedCopies: value, jokers: 2 })).toThrow();
    expect(() => createDeck({ numberedCopies: 2, jokers: value })).toThrow();
  }
  for (const seed of [-1, 1.5, NaN, Infinity, 0x100000000])
    expect(() => seededShuffle([], seed)).toThrow();
  expect(() => createDeck({ numberedCopies: 0, jokers: 0 })).toThrow();
});
it("shuffles reproducibly, preserves all identities and input over 100 seeds", () => {
  const deck = createDeck({ numberedCopies: 4, jokers: 6 });
  const before = structuredClone(deck);
  for (let seed = 0; seed < 100; seed++) {
    const result = seededShuffle(deck, seed);
    expect(result).toEqual(seededShuffle(deck, seed));
    expect(result).not.toEqual(deck);
    expect(new Set(result)).toEqual(new Set(deck));
  }
  expect(deck).toEqual(before);
  expect(seededShuffle([], 0)).toEqual([]);
  expect(seededShuffle([1], 0)).toEqual([1]);
});
it("checks eight racks, board and bag for loss, duplication, forgery and alteration", () => {
  const deck = createDeck({ numberedCopies: 4, jokers: 6 });
  const inventory: TileInventory = {
    players: Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      rack: deck.slice(i * 14, (i + 1) * 14),
    })),
    board: [deck.slice(112, 115)],
    bag: deck.slice(115),
  };
  expect(() => assertTileConservation(deck, inventory)).not.toThrow();
  expect(() =>
    assertTileConservation(deck, { ...inventory, bag: inventory.bag.slice(1) }),
  ).toThrow("Missing");
  expect(() =>
    assertTileConservation(deck, {
      ...inventory,
      bag: [...inventory.bag, deck[0]!],
    }),
  ).toThrow("Duplicate");
  expect(() =>
    assertTileConservation(deck, {
      ...inventory,
      bag: [{ id: "forged", kind: "joker" }, ...inventory.bag.slice(1)],
    }),
  ).toThrow("Unknown");
  expect(() =>
    assertTileConservation(deck, {
      ...inventory,
      bag: [
        { id: inventory.bag[0]!.id, kind: "joker" },
        ...inventory.bag.slice(1),
      ],
    }),
  ).toThrow("altered");
  expect(() => assertTileConservation([...deck, deck[0]!], inventory)).toThrow(
    "Duplicate deck",
  );
  expect(() =>
    assertTileConservation(deck, {
      ...inventory,
      players: [...inventory.players, inventory.players[0]!],
    }),
  ).toThrow("Duplicate player");
});
