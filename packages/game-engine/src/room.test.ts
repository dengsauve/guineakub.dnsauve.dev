import { expect, it } from "vitest";
import {
  createGameRoom,
  startRoomRound,
  resetRoomScores,
  applyRoomCommand,
  createDeck,
  type GameRoom,
  type Placement,
  type TileNumber,
} from "./index";
const deck = () => createDeck({ numberedCopies: 2, jokers: 2 });
function winningRoom(): GameRoom {
  const base = startRoomRound(
    createGameRoom("family", ["a", "b"]),
    0,
    ["a", "b"],
    deck(),
  );
  const rack = deck().filter((t) =>
    ["number:1:red:10", "number:1:red:11", "number:1:red:12"].includes(t.id),
  );
  const other = deck().find((t) => t.id === "number:1:blue:1")!;
  const used = new Set([...rack, other].map((t) => t.id));
  return {
    ...base,
    round: {
      ...base.round!,
      players: [
        { id: "a", rack, opened: true },
        { id: "b", rack: [other], opened: false },
      ],
      bag: deck().filter((t) => !used.has(t.id)),
    },
  };
}
function win(room: GameRoom) {
  return applyRoomCommand(room, room.revision, {
    type: "play",
    playerId: "a",
    expectedRevision: room.round!.revision,
    steps: [
      {
        type: "lay",
        melds: [
          {
            id: "win",
            kind: "run",
            tiles: [10, 11, 12].map(
              (value) =>
                ({
                  tileId: `number:1:red:${value}`,
                  color: "red",
                  value: value as TileNumber,
                }) satisfies Placement,
            ),
          },
        ],
      },
    ],
  });
}
it("preserves scores through new rounds, adds each result once and supports any member lobby reset", () => {
  let room = winningRoom();
  const before = structuredClone(room);
  const completed = win(room);
  if (!completed.ok) throw new Error(completed.code);
  expect(room).toEqual(before);
  room = completed.room;
  expect(room.scores).toEqual({ a: 0, b: 1 });
  expect(room.roundsPlayed).toBe(1);
  expect(win(room)).toEqual({ ok: false, code: "ROUND_FINISHED" });
  const reset = resetRoomScores(room, "b", room.revision);
  expect(reset.scores).toEqual({ a: 0, b: 0 });
  expect(room.scores.b).toBe(1);
  const next = startRoomRound(room, room.revision, ["b", "a"], deck());
  expect(next.round!.players.map((p) => p.id)).toEqual(["b", "a"]);
  expect(next.scores).toEqual({ a: 0, b: 1 });
  expect(next.roundsPlayed).toBe(1);
  const again = win({ ...winningRoom(), scores: room.scores, roundsPlayed: 1 });
  if (!again.ok) throw new Error(again.code);
  expect(again.room.scores).toEqual({ a: 0, b: 2 });
});
it("rejects stale lobby actions, nonmember reset, reset/start during game and invalid order", () => {
  const lobby = createGameRoom("family", ["a", "b"]);
  expect(() => resetRoomScores(lobby, "stranger", 0)).toThrow("NOT_A_MEMBER");
  expect(() => resetRoomScores(lobby, "a", 1)).toThrow("STALE_ROOM_REVISION");
  expect(() => startRoomRound(lobby, 1, ["a", "b"], deck())).toThrow();
  expect(() => startRoomRound(lobby, 0, ["a", "a"], deck())).toThrow(
    "INVALID_PLAYER_ORDER",
  );
  expect(() => startRoomRound(lobby, 0, ["a", "outsider"], deck())).toThrow(
    "INVALID_PLAYER_ORDER",
  );
  const room = winningRoom();
  expect(() => resetRoomScores(room, "b", room.revision)).toThrow(
    "ROUND_IN_PROGRESS",
  );
  expect(() => startRoomRound(room, room.revision, ["a", "b"], deck())).toThrow(
    "ROUND_IN_PROGRESS",
  );
  expect(
    applyRoomCommand(room, 0, {
      type: "draw",
      playerId: "a",
      expectedRevision: 0,
    }),
  ).toEqual({ ok: false, code: "STALE_ROOM_REVISION" });
});
it("handles special property names as ordinary player IDs", () => {
  const lobby = createGameRoom("family", ["__proto__", "constructor"]);
  expect(Object.keys(lobby.scores)).toEqual(["__proto__", "constructor"]);
  expect(resetRoomScores(lobby, "__proto__", 0).scores.constructor).toBe(0);
});
