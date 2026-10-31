import { describe, expect, it } from "vitest";
import {
  createDeck,
  validateMeld,
  validateBoard,
  type Color,
  type Placement,
  type ProposedMeld,
  type TileNumber,
} from "./index";
const deck = createDeck({ numberedCopies: 4, jokers: 6 });
const catalog = new Map(deck.map((tile) => [tile.id, tile]));
const n = (value: number, color: Color = "red", copy = 1): Placement => ({
  tileId: `number:${copy}:${color}:${value}`,
  value: value as TileNumber,
  color,
});
const j = (value: number, color: Color = "red", copy = 1): Placement => ({
  tileId: `joker:${copy}`,
  value: value as TileNumber,
  color,
});
const meld = (
  kind: ProposedMeld["kind"],
  tiles: Placement[],
): ProposedMeld => ({ id: "m", kind, tiles });
describe("groups", () => {
  it("accepts three/four distinct colors and values jokers by representation", () => {
    expect(
      validateMeld(
        meld("group", [n(10), n(10, "blue"), j(10, "black")]),
        catalog,
      ),
    ).toEqual({ ok: true, points: 30 });
    expect(
      validateMeld(
        meld("group", [n(2), n(2, "blue"), j(2, "black"), j(2, "orange", 2)]),
        catalog,
      ),
    ).toEqual({ ok: true, points: 8 });
    expect(
      validateMeld(
        meld("group", [
          n(13),
          j(13, "blue"),
          j(13, "black", 2),
          j(13, "orange", 3),
        ]),
        catalog,
      ).ok,
    ).toBe(true);
  });
  it.each([
    [n(2), n(2, "red", 2), n(2, "blue")],
    [n(2), n(3, "blue"), n(2, "black")],
    [n(2), n(2, "blue"), j(2, "red")],
  ])("rejects repeated colors or unequal values", (...tiles) => {
    expect(validateMeld(meld("group", tiles), catalog).ok).toBe(false);
  });
});
describe("runs", () => {
  it("accepts endpoints, full length and multiple jokers with one numbered tile", () => {
    for (const tiles of [
      [n(1), n(2), n(3)],
      [n(11), n(12), n(13)],
      [j(1), n(2), j(3, "red", 2)],
      Array.from({ length: 13 }, (_, i) => n(i + 1)),
    ])
      expect(validateMeld(meld("run", tiles), catalog).ok).toBe(true);
  });
  it.each([
    [n(12), n(13), n(1)],
    [n(1), n(3), n(4)],
    [n(1), n(2, "blue"), n(3)],
    [n(3), n(2), n(1)],
    [n(1), n(1, "red", 2), n(2)],
    [n(11), n(12), j(14)],
  ])(
    "rejects wrapping, gaps, mixed colors, descending and duplicate numbers",
    (...tiles) => {
      expect(validateMeld(meld("run", tiles), catalog).ok).toBe(false);
    },
  );
});
it("rejects all-joker melds, short/long melds and forged physical values", () => {
  expect(
    validateMeld(meld("run", [j(1), j(2, "red", 2), j(3, "red", 3)]), catalog),
  ).toEqual({ ok: false, code: "ALL_JOKERS" });
  for (const tiles of [
    [n(1), n(2)],
    [n(1), n(2), { ...n(3), value: 4 as TileNumber }],
    [n(1), n(2), { ...n(3), tileId: "unknown" }],
    [n(1), n(2), { ...j(3), color: "pink" as Color }],
  ])
    expect(validateMeld(meld("run", tiles), catalog).ok).toBe(false);
  expect(
    validateMeld(
      meld("group", [n(2), n(2, "blue"), n(2, "black"), n(2, "orange"), j(2)]),
      catalog,
    ).ok,
  ).toBe(false);
});
it("rejects reuse of physical tiles/meld IDs across board", () => {
  const a = meld("run", [n(1), n(2), n(3)]);
  expect(validateBoard([a, { ...a, id: "b" }], catalog)).toEqual({
    ok: false,
    code: "DUPLICATE_TILE",
  });
  expect(validateBoard([a, a], catalog)).toEqual({
    ok: false,
    code: "DUPLICATE_MELD",
  });
  expect(validateMeld({ ...a, id: "" }, catalog).ok).toBe(false);
  expect(validateBoard([], catalog)).toEqual({ ok: true, points: 0 });
});
it("exhausts every run interval and every single joker position", () => {
  for (let start = 1; start <= 11; start++)
    for (let end = start + 2; end <= 13; end++)
      for (let joker = start; joker <= end; joker++) {
        const tiles = Array.from({ length: end - start + 1 }, (_, i) =>
          i + start === joker ? j(i + start) : n(i + start),
        );
        expect(validateMeld(meld("run", tiles), catalog)).toEqual({
          ok: true,
          points: ((start + end) * tiles.length) / 2,
        });
      }
});
