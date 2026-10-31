export const COLORS = ["red", "blue", "black", "orange"] as const;
export type Color = (typeof COLORS)[number];
export type TileNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export type Tile =
  | Readonly<{ id: string; kind: "number"; color: Color; value: TileNumber }>
  | Readonly<{ id: string; kind: "joker" }>;
export type Rack = readonly Tile[];
export type Meld = readonly Tile[];
export type Board = readonly Meld[];
export type Bag = readonly Tile[];
export interface Player {
  readonly id: string;
  readonly rack: Rack;
}
export interface TileInventory {
  readonly board: Board;
  readonly bag: Bag;
  readonly players: readonly Player[];
}
export interface DeckConfig {
  readonly numberedCopies: number;
  readonly jokers: number;
}
/** Explicit physical composition. Use deckConfigForPlayers for approved game presets. */
export function createDeck(config: DeckConfig): Tile[] {
  if (
    !Number.isSafeInteger(config.numberedCopies) ||
    config.numberedCopies < 1 ||
    config.numberedCopies > 4 ||
    !Number.isSafeInteger(config.jokers) ||
    config.jokers < 0 ||
    config.jokers > 8
  )
    throw new RangeError("Expected 1–4 copies and 0–8 jokers");
  const tiles: Tile[] = [];
  for (let copy = 1; copy <= config.numberedCopies; copy++)
    for (const color of COLORS)
      for (let value = 1; value <= 13; value++)
        tiles.push({
          id: `number:${copy}:${color}:${value}`,
          kind: "number",
          color,
          value: value as TileNumber,
        });
  for (let copy = 1; copy <= config.jokers; copy++)
    tiles.push({ id: `joker:${copy}`, kind: "joker" });
  return tiles;
}
/** Reproducible Fisher–Yates for tests; not a security RNG. Does not mutate input. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError("Expected uint32 seed");
  let state = seed;
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    const j = Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
export function assertTileConservation(
  deck: readonly Tile[],
  inventory: TileInventory,
): void {
  const expected = new Map(deck.map((tile) => [tile.id, tile]));
  if (expected.size !== deck.length) throw new Error("Duplicate deck tile");
  if (
    new Set(inventory.players.map((p) => p.id)).size !==
    inventory.players.length
  )
    throw new Error("Duplicate player");
  const seen = new Set<string>();
  for (const tile of [
    ...inventory.bag,
    ...inventory.board.flat(),
    ...inventory.players.flatMap((p) => p.rack),
  ]) {
    const original = expected.get(tile.id);
    if (
      !original ||
      original.kind !== tile.kind ||
      (original.kind === "number" &&
        (tile.kind !== "number" ||
          original.color !== tile.color ||
          original.value !== tile.value))
    )
      throw new Error("Unknown or altered tile");
    if (seen.has(tile.id)) throw new Error("Duplicate inventory tile");
    seen.add(tile.id);
  }
  if (seen.size !== expected.size) throw new Error("Missing tile");
}
