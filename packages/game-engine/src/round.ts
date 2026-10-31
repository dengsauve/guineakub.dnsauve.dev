import {
  createDeck,
  seededShuffle,
  assertTileConservation,
  type DeckConfig,
  type Tile,
} from "./tiles";
import { validateBoard, type ProposedMeld } from "./melds";

export interface RoundPlayer {
  readonly id: string;
  readonly rack: readonly Tile[];
  readonly opened: boolean;
}
export interface RoundResult {
  readonly reason: "empty-rack" | "blocked";
  readonly winners: readonly string[];
  readonly points: Readonly<Record<string, number>>;
}
/** Private authoritative state. Never send this object directly to a client. */
export interface RoundState {
  readonly deck: readonly Tile[];
  readonly players: readonly RoundPlayer[];
  readonly board: readonly ProposedMeld[];
  readonly bag: readonly Tile[];
  readonly turnIndex: number;
  readonly revision: number;
  readonly consecutivePasses: number;
  readonly result: RoundResult | null;
}
/** Room membership/hosting and authentication belong to the server, not this model. */
export interface GameRoom {
  readonly id: string;
  readonly revision: number;
  readonly roundsPlayed: number;
  readonly playerIds: readonly string[];
  readonly scores: Readonly<Record<string, number>>;
  readonly round: RoundState | null;
}
export function deckConfigForPlayers(count: number): DeckConfig {
  if (!Number.isInteger(count) || count < 2 || count > 8)
    throw new RangeError("Expected 2–8 players");
  return count <= 4
    ? { numberedCopies: 2, jokers: 2 }
    : count <= 6
      ? { numberedCopies: 3, jokers: 4 }
      : { numberedCopies: 4, jokers: 6 };
}

/**
 * Caller supplies already securely shuffled physical tiles and player IDs in turn
 * order. Seeded test shuffle is deliberately not used as production randomness.
 */
export function dealRound(
  playerIds: readonly string[],
  shuffledDeck: readonly Tile[],
): RoundState {
  const canonical = createDeck(deckConfigForPlayers(playerIds.length));
  if (
    playerIds.some((id) => typeof id !== "string" || !id.length) ||
    new Set(playerIds).size !== playerIds.length
  )
    throw new Error("Expected unique nonempty player IDs");
  assertTileConservation(canonical, {
    board: [],
    bag: shuffledDeck,
    players: [],
  });
  // Copy canonical values, so callers cannot mutate physical tiles after dealing.
  const catalog = new Map(canonical.map((tile) => [tile.id, tile]));
  const deck = shuffledDeck.map((tile) => catalog.get(tile.id)!);
  const racks: Tile[][] = playerIds.map(() => []);
  let cursor = 0;
  for (let tile = 0; tile < 14; tile++)
    for (const rack of racks) rack.push(deck[cursor++]!);
  return {
    deck,
    players: playerIds.map((id, index) => ({
      id,
      rack: racks[index]!,
      opened: false,
    })),
    board: [],
    bag: deck.slice(cursor),
    turnIndex: 0,
    revision: 0,
    consecutivePasses: 0,
    result: null,
  };
}
/** Deterministic helper for fixtures and simulations, not production game setup. */
export function createTestRound(
  playerIds: readonly string[],
  deckSeed: number,
  orderSeed: number,
): RoundState {
  const deck = createDeck(deckConfigForPlayers(playerIds.length));
  return dealRound(
    seededShuffle(playerIds, orderSeed),
    seededShuffle(deck, deckSeed),
  );
}
export function assertRoundInventory(state: RoundState): void {
  const approvedDeck = createDeck(deckConfigForPlayers(state.players.length));
  if (
    state.players.some((player) => !player.id) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    state.revision > Number.MAX_SAFE_INTEGER ||
    !Number.isInteger(state.turnIndex) ||
    state.turnIndex < 0 ||
    state.turnIndex >= state.players.length ||
    !Number.isInteger(state.consecutivePasses) ||
    state.consecutivePasses < 0 ||
    state.consecutivePasses > state.players.length
  )
    throw new Error("Invalid round metadata");
  assertTileConservation(approvedDeck, {
    bag: state.deck,
    players: [],
    board: [],
  });
  const catalog = new Map(state.deck.map((tile) => [tile.id, tile]));
  const board = validateBoard(state.board, catalog);
  if (!board.ok) throw new Error(board.code);
  assertTileConservation(state.deck, {
    players: state.players,
    bag: state.bag,
    board: state.board.map((meld) =>
      meld.tiles.map((placement) => catalog.get(placement.tileId)!),
    ),
  });
}
export function rackPoints(rack: readonly Tile[]): number {
  return rack.reduce(
    (sum, tile) => sum + (tile.kind === "joker" ? 30 : tile.value),
    0,
  );
}
/** Pure round scoring, including ties. Completion/turn validation is separate. */
export function scoreRound(
  players: readonly RoundPlayer[],
  reason: RoundResult["reason"],
): RoundResult {
  if (
    players.length < 2 ||
    players.length > 8 ||
    new Set(players.map((player) => player.id)).size !== players.length
  )
    throw new Error("Expected 2–8 unique players");
  const points = Object.fromEntries(
    players.map((player) => [player.id, rackPoints(player.rack)]),
  );
  const minimum = Math.min(...Object.values(points));
  const winners = players
    .filter((player) =>
      reason === "empty-rack"
        ? player.rack.length === 0
        : points[player.id] === minimum,
    )
    .map((player) => player.id);
  if (reason === "empty-rack" && winners.length !== 1)
    throw new Error("Expected exactly one empty rack");
  return { reason, winners, points };
}
