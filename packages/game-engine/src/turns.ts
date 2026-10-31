import { assertTileConservation, type Tile } from "./tiles";
import { validateBoard, type ProposedMeld } from "./melds";
import { assertRoundInventory, scoreRound, type RoundState } from "./round";

export type TurnStep =
  | Readonly<{ type: "open"; melds: readonly ProposedMeld[] }>
  | Readonly<{ type: "lay"; melds: readonly ProposedMeld[] }>
  | Readonly<{
      type: "split-run";
      sourceId: string;
      melds: readonly ProposedMeld[];
    }>
  | Readonly<{
      type: "rearrange";
      sourceIds: readonly string[];
      melds: readonly ProposedMeld[];
    }>
  | Readonly<{
      type: "retrieve-joker";
      sourceId: string;
      jokerId: string;
      replacementId?: string;
      melds: readonly ProposedMeld[];
    }>
  | Readonly<{
      type: "detach-numbered";
      sourceId: string;
      tileId: string;
      replacementId?: string;
      melds: readonly ProposedMeld[];
    }>;
export type RoundCommand = Readonly<{
  playerId: string;
  expectedRevision: number;
}> &
  (
    | Readonly<{ type: "play"; steps: readonly TurnStep[] }>
    | Readonly<{ type: "draw" | "pass" }>
  );
export type CommandError =
  | "ROUND_FINISHED"
  | "STALE_REVISION"
  | "NOT_YOUR_TURN"
  | "INVALID_STATE"
  | "INVALID_PLAY"
  | "OPENING_REQUIRED"
  | "INVALID_OPENING"
  | "INVALID_MELD"
  | "TILE_OWNERSHIP"
  | "TILE_CONSERVATION"
  | "JOKER_RETRIEVAL_REQUIRED"
  | "INVALID_RETRIEVAL"
  | "JOKER_NOT_REUSED"
  | "BOARD_TILE_NOT_REUSED"
  | "NO_RACK_TILE_PLAYED"
  | "EMPTY_BAG"
  | "BAG_NOT_EMPTY";
export type CommandResult =
  | Readonly<{ ok: true; state: RoundState }>
  | Readonly<{ ok: false; code: CommandError }>;
class InvalidTurn extends Error {
  constructor(readonly code: CommandError) {
    super(code);
  }
}
function requireRule(
  condition: unknown,
  code: CommandError,
): asserts condition {
  if (!condition) throw new InvalidTurn(code);
}
const tileIds = (melds: readonly ProposedMeld[]) =>
  melds.flatMap((meld) => meld.tiles.map((tile) => tile.tileId));
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  a.every((id) => b.includes(id));

/**
 * Atomic pure transaction. All intermediate steps are validated on private copies.
 * Failure returns no candidate state; caller retains the original committed state.
 * Network identity, command-ID deduplication and durable commit belong to server.
 */
export function applyRoundCommand(
  state: RoundState,
  command: RoundCommand,
): CommandResult {
  if (state.result) return { ok: false, code: "ROUND_FINISHED" };
  if (command.expectedRevision !== state.revision)
    return { ok: false, code: "STALE_REVISION" };
  if (state.players[state.turnIndex]?.id !== command.playerId)
    return { ok: false, code: "NOT_YOUR_TURN" };
  if (state.revision === Number.MAX_SAFE_INTEGER)
    return { ok: false, code: "INVALID_STATE" };
  try {
    assertRoundInventory(state);
  } catch {
    return { ok: false, code: "INVALID_STATE" };
  }
  // Clone the complete candidate so neither commands nor results alias caller data.
  const next = structuredClone(state);
  const player = next.players[next.turnIndex]!;
  const rack = [...player.rack];
  let board = [...next.board];
  let opened = player.opened;
  const held = new Set<string>();
  const catalog = new Map(next.deck.map((tile) => [tile.id, tile]));
  const initialRack = new Set(rack.map((tile) => tile.id));
  let passes = 0;
  function checkBoard(melds: readonly ProposedMeld[]) {
    requireRule(validateBoard(melds, catalog).ok, "INVALID_MELD");
  }
  function consume(ids: readonly string[]) {
    requireRule(new Set(ids).size === ids.length, "TILE_CONSERVATION");
    for (const id of ids) {
      if (held.delete(id)) continue;
      const index = rack.findIndex((tile) => tile.id === id);
      requireRule(index >= 0, "TILE_OWNERSHIP");
      rack.splice(index, 1);
    }
  }
  function checkInventory() {
    try {
      assertTileConservation(next.deck, {
        bag: next.bag,
        board: board.map((meld) =>
          meld.tiles.map((placement) => catalog.get(placement.tileId)!),
        ),
        players: next.players.map((p, index) =>
          index === next.turnIndex
            ? {
                ...p,
                rack: [...rack, ...[...held].map((id) => catalog.get(id)!)],
              }
            : p,
        ),
      });
    } catch {
      throw new InvalidTurn("TILE_CONSERVATION");
    }
  }
  try {
    if (command.type === "draw") {
      requireRule(next.bag.length > 0, "EMPTY_BAG");
      rack.push(next.bag[0]!);
    } else if (command.type === "pass") {
      requireRule(next.bag.length === 0, "BAG_NOT_EMPTY");
      passes = next.consecutivePasses + 1;
    } else {
      requireRule(
        command.type === "play" && command.steps.length > 0,
        "INVALID_PLAY",
      );
      for (const rawStep of command.steps) {
        const step = structuredClone(rawStep);
        if (step.type === "open" || step.type === "lay") {
          checkBoard(step.melds);
          requireRule(step.melds.length > 0, "INVALID_PLAY");
          if (step.type === "open") {
            requireRule(!opened, "INVALID_OPENING");
            const result = validateBoard(step.melds, catalog);
            requireRule(result.ok && result.points >= 30, "INVALID_OPENING");
            // Explicit rack-only stage proves the opening preceded manipulation.
            requireRule(
              tileIds(step.melds).every((id) =>
                rack.some((tile) => tile.id === id),
              ),
              "INVALID_OPENING",
            );
            opened = true;
          } else requireRule(opened, "OPENING_REQUIRED");
          consume(tileIds(step.melds));
          board.push(...step.melds);
        } else if (step.type === "split-run") {
          requireRule(opened, "OPENING_REQUIRED");
          const source = board.find((meld) => meld.id === step.sourceId);
          requireRule(source?.kind === "run", "INVALID_PLAY");
          checkBoard(step.melds);
          requireRule(
            step.melds.length >= 2 &&
              step.melds.every((meld) => meld.kind === "run"),
            "INVALID_PLAY",
          );
          // Explicit contiguous slices retain any joker in its original segment.
          requireRule(
            sameIds(tileIds([source]), tileIds(step.melds)),
            "TILE_CONSERVATION",
          );
          let cursor = 0;
          for (const meld of step.melds) {
            requireRule(
              meld.tiles.every(
                (tile, i) => tile.tileId === source.tiles[cursor + i]?.tileId,
              ),
              "INVALID_PLAY",
            );
            cursor += meld.tiles.length;
          }
          board = [
            ...board.filter((meld) => meld.id !== source.id),
            ...step.melds,
          ];
        } else if (step.type === "rearrange") {
          requireRule(opened, "OPENING_REQUIRED");
          requireRule(
            step.sourceIds.length > 0 &&
              new Set(step.sourceIds).size === step.sourceIds.length,
            "INVALID_PLAY",
          );
          const sources = step.sourceIds.map((id) => {
            const meld = board.find((meld) => meld.id === id);
            requireRule(meld, "INVALID_PLAY");
            return meld;
          });
          checkBoard(step.melds);
          const beforeIds = tileIds(sources);
          const afterIds = tileIds(step.melds);
          requireRule(
            beforeIds.every((id) => afterIds.includes(id)),
            "TILE_CONSERVATION",
          );
          for (const source of sources) {
            for (const placement of source.tiles) {
              if (catalog.get(placement.tileId)?.kind !== "joker") continue;
              // A joker may remain with its entire source, including when merging melds.
              // Separating it from source tiles needs a split or validated release.
              requireRule(
                step.melds.some((meld) =>
                  source.tiles.every((original) =>
                    meld.tiles.some((tile) => tile.tileId === original.tileId),
                  ),
                ),
                "JOKER_RETRIEVAL_REQUIRED",
              );
            }
          }
          consume(afterIds.filter((id) => !beforeIds.includes(id)));
          board = [
            ...board.filter((meld) => !step.sourceIds.includes(meld.id)),
            ...step.melds,
          ];
        } else if (
          step.type === "retrieve-joker" ||
          step.type === "detach-numbered"
        ) {
          requireRule(opened, "OPENING_REQUIRED");
          const source = board.find((meld) => meld.id === step.sourceId);
          requireRule(source, "INVALID_RETRIEVAL");
          const removedId =
            step.type === "retrieve-joker" ? step.jokerId : step.tileId;
          const index = source.tiles.findIndex(
            (tile) => tile.tileId === removedId,
          );
          requireRule(
            index >= 0 &&
              catalog.get(removedId)?.kind ===
                (step.type === "retrieve-joker" ? "joker" : "number"),
            "INVALID_RETRIEVAL",
          );
          checkBoard(step.melds);
          requireRule(
            step.melds.length === 1 || step.melds.length === 2,
            "INVALID_RETRIEVAL",
          );
          const rest = source.tiles.filter((tile) => tile.tileId !== removedId);
          const expectedIds = rest.map((tile) => tile.tileId);
          if (step.replacementId !== undefined) {
            const replacement = rack.find(
              (tile) => tile.id === step.replacementId,
            );
            requireRule(
              replacement?.kind === "number" && step.melds.length === 1,
              "INVALID_RETRIEVAL",
            );
            const target = source.tiles[index]!;
            requireRule(
              replacement.value === target.value,
              "INVALID_RETRIEVAL",
            );
            if (source.kind === "run")
              requireRule(
                replacement.color === target.color,
                "INVALID_RETRIEVAL",
              );
            expectedIds.push(replacement.id);
          }
          requireRule(
            sameIds(expectedIds, tileIds(step.melds)),
            "INVALID_RETRIEVAL",
          );
          requireRule(
            step.melds.every((meld) => meld.kind === source.kind),
            "INVALID_RETRIEVAL",
          );
          if (step.melds.length === 2) {
            requireRule(
              source.kind === "run" && step.replacementId === undefined,
              "INVALID_RETRIEVAL",
            );
            const left = source.tiles
              .slice(0, index)
              .map((tile) => tile.tileId);
            const right = source.tiles
              .slice(index + 1)
              .map((tile) => tile.tileId);
            requireRule(
              step.melds.some((meld) => sameIds(left, tileIds([meld]))) &&
                step.melds.some((meld) => sameIds(right, tileIds([meld]))),
              "INVALID_RETRIEVAL",
            );
          }
          if (step.replacementId !== undefined) consume([step.replacementId]);
          board = [
            ...board.filter((meld) => meld.id !== source.id),
            ...step.melds,
          ];
          held.add(removedId);
        } else throw new InvalidTurn("INVALID_PLAY");
        checkBoard(board);
        checkInventory();
      }
      requireRule(opened, "OPENING_REQUIRED");
      requireRule(
        ![...held].some((id) => catalog.get(id)?.kind === "joker"),
        "JOKER_NOT_REUSED",
      );
      requireRule(held.size === 0, "BOARD_TILE_NOT_REUSED");
      requireRule(
        rack.some((tile) => !initialRack.has(tile.id)) === false &&
          rack.length < initialRack.size,
        "NO_RACK_TILE_PLAYED",
      );
    }
    const players = next.players.map((p, index) =>
      index === next.turnIndex ? { ...p, rack, opened } : p,
    );
    const result =
      command.type === "play" && rack.length === 0
        ? scoreRound(players, "empty-rack")
        : passes >= players.length
          ? scoreRound(players, "blocked")
          : null;
    const candidate: RoundState = {
      ...next,
      players,
      board,
      bag: command.type === "draw" ? next.bag.slice(1) : next.bag,
      revision: next.revision + 1,
      turnIndex: result
        ? next.turnIndex
        : (next.turnIndex + 1) % players.length,
      consecutivePasses: passes,
      result,
    };
    assertRoundInventory(candidate);
    return { ok: true, state: candidate };
  } catch (error) {
    if (error instanceof InvalidTurn) return { ok: false, code: error.code };
    throw error;
  }
}
/** Draft reset is a local copy, with no revision or committed-state change. */
export function resetTurnDraft(
  state: RoundState,
  playerId: string,
): Readonly<{
  revision: number;
  board: readonly ProposedMeld[];
  rack: readonly Tile[];
}> {
  const player = state.players.find((player) => player.id === playerId);
  if (!player) throw new Error("Player is not a member");
  return structuredClone({
    revision: state.revision,
    board: state.board,
    rack: player.rack,
  });
}
