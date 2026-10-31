import { COLORS, type Color, type Tile, type TileNumber } from "./tiles";

/** A joker's represented value is local to a proposed meld, never its physical tile. */
export interface Placement {
  readonly tileId: string;
  readonly color: Color;
  readonly value: TileNumber;
}
export interface ProposedMeld {
  readonly id: string;
  readonly kind: "group" | "run";
  /** Runs are submitted in ascending order. Group ordering is immaterial. */
  readonly tiles: readonly Placement[];
}
export type MeldError =
  | "INVALID_KIND"
  | "INVALID_LENGTH"
  | "DUPLICATE_TILE"
  | "UNKNOWN_TILE"
  | "INVALID_REPRESENTATION"
  | "NUMBER_TILE_CHANGED"
  | "ALL_JOKERS"
  | "INVALID_GROUP"
  | "INVALID_RUN"
  | "DUPLICATE_MELD"
  | "INVALID_MELD_ID";
export type MeldResult =
  | Readonly<{ ok: true; points: number }>
  | Readonly<{ ok: false; code: MeldError }>;
const invalid = (code: MeldError): MeldResult => ({ ok: false, code });

/** Pure validation against canonical physical tiles; does not accept invented tiles. */
export function validateMeld(
  meld: ProposedMeld,
  catalog: ReadonlyMap<string, Tile>,
): MeldResult {
  if (typeof meld.id !== "string" || meld.id.length === 0)
    return invalid("INVALID_MELD_ID");
  if (meld.kind !== "group" && meld.kind !== "run")
    return invalid("INVALID_KIND");
  if (
    meld.tiles.length < 3 ||
    meld.tiles.length > (meld.kind === "group" ? 4 : 13)
  )
    return invalid("INVALID_LENGTH");
  const seen = new Set<string>();
  let numbered = 0;
  for (const placement of meld.tiles) {
    if (seen.has(placement.tileId)) return invalid("DUPLICATE_TILE");
    seen.add(placement.tileId);
    const tile = catalog.get(placement.tileId);
    if (!tile) return invalid("UNKNOWN_TILE");
    if (
      !COLORS.includes(placement.color) ||
      !Number.isInteger(placement.value) ||
      placement.value < 1 ||
      placement.value > 13
    )
      return invalid("INVALID_REPRESENTATION");
    if (tile.kind === "number") {
      numbered++;
      if (tile.color !== placement.color || tile.value !== placement.value)
        return invalid("NUMBER_TILE_CHANGED");
    }
  }
  if (numbered === 0) return invalid("ALL_JOKERS");
  const first = meld.tiles[0]!;
  if (meld.kind === "group") {
    if (
      meld.tiles.some((tile) => tile.value !== first.value) ||
      new Set(meld.tiles.map((tile) => tile.color)).size !== meld.tiles.length
    )
      return invalid("INVALID_GROUP");
  } else if (
    meld.tiles.some(
      (tile, index) =>
        tile.color !== first.color || tile.value !== first.value + index,
    )
  )
    return invalid("INVALID_RUN");
  return {
    ok: true,
    points: meld.tiles.reduce((sum, tile) => sum + tile.value, 0),
  };
}

/** Also rejects physical tiles or meld IDs reused across different melds. */
export function validateBoard(
  board: readonly ProposedMeld[],
  catalog: ReadonlyMap<string, Tile>,
): MeldResult {
  const ids = new Set<string>();
  const tiles = new Set<string>();
  let points = 0;
  for (const meld of board) {
    if (ids.has(meld.id)) return invalid("DUPLICATE_MELD");
    ids.add(meld.id);
    const result = validateMeld(meld, catalog);
    if (!result.ok) return result;
    points += result.points;
    for (const tile of meld.tiles) {
      if (tiles.has(tile.tileId)) return invalid("DUPLICATE_TILE");
      tiles.add(tile.tileId);
    }
  }
  return { ok: true, points };
}
