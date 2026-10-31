import { dealRound, type GameRoom } from "./round";
import {
  applyRoundCommand,
  type RoundCommand,
  type CommandError,
} from "./turns";
import { type Tile } from "./tiles";

export function createGameRoom(
  id: string,
  playerIds: readonly string[],
): GameRoom {
  if (
    !id ||
    playerIds.length < 2 ||
    playerIds.length > 8 ||
    playerIds.some((id) => !id) ||
    new Set(playerIds).size !== playerIds.length
  )
    throw new Error("Expected a room ID and 2–8 unique player IDs");
  return {
    id,
    playerIds: [...playerIds],
    scores: Object.fromEntries(playerIds.map((id) => [id, 0])),
    revision: 0,
    roundsPlayed: 0,
    round: null,
  };
}
function checkRevision(room: GameRoom, expectedRevision: number) {
  if (
    room.revision !== expectedRevision ||
    !Number.isSafeInteger(room.revision) ||
    room.revision < 0 ||
    room.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("STALE_ROOM_REVISION");
}
/** Server authorizes start and supplies secure shuffled order/deck. */
export function startRoomRound(
  room: GameRoom,
  expectedRevision: number,
  playerOrder: readonly string[],
  shuffledDeck: readonly Tile[],
): GameRoom {
  checkRevision(room, expectedRevision);
  if (room.round && !room.round.result) throw new Error("ROUND_IN_PROGRESS");
  if (
    playerOrder.length !== room.playerIds.length ||
    new Set(playerOrder).size !== playerOrder.length ||
    playerOrder.some((id) => !room.playerIds.includes(id))
  )
    throw new Error("INVALID_PLAYER_ORDER");
  return {
    ...structuredClone(room),
    round: dealRound(playerOrder, shuffledDeck),
    revision: room.revision + 1,
  };
}
/** Apply scores exactly when a round completes, never again on a retry. */
export function applyRoomCommand(
  room: GameRoom,
  expectedRevision: number,
  command: RoundCommand,
):
  | Readonly<{ ok: true; room: GameRoom }>
  | Readonly<{
      ok: false;
      code: CommandError | "STALE_ROOM_REVISION" | "NO_ACTIVE_ROUND";
    }> {
  if (
    room.revision !== expectedRevision ||
    !Number.isSafeInteger(room.revision) ||
    room.revision < 0 ||
    room.revision >= Number.MAX_SAFE_INTEGER
  )
    return { ok: false, code: "STALE_ROOM_REVISION" };
  if (!room.round) return { ok: false, code: "NO_ACTIVE_ROUND" };
  const result = applyRoundCommand(room.round, command);
  if (!result.ok) return result;
  const scores = Object.fromEntries(
    room.playerIds.map((id) => [
      id,
      (room.scores[id] ?? 0) + (result.state.result?.points[id] ?? 0),
    ]),
  );
  return {
    ok: true,
    room: {
      ...structuredClone(room),
      round: result.state,
      scores,
      revision: room.revision + 1,
      roundsPlayed: room.roundsPlayed + (result.state.result ? 1 : 0),
    },
  };
}
/** Every member may reset in the lobby (before/between rounds). */
export function resetRoomScores(
  room: GameRoom,
  playerId: string,
  expectedRevision: number,
): GameRoom {
  checkRevision(room, expectedRevision);
  if (!room.playerIds.includes(playerId)) throw new Error("NOT_A_MEMBER");
  if (room.round && !room.round.result) throw new Error("ROUND_IN_PROGRESS");
  return {
    ...structuredClone(room),
    scores: Object.fromEntries(room.playerIds.map((id) => [id, 0])),
    revision: room.revision + 1,
  };
}
