import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import {
  createGameRoom,
  startRoomRound,
  resetRoomScores,
  applyRoomCommand,
  createDeck,
  deckConfigForPlayers,
  assertRoundInventory,
  scoreRound,
  type GameRoom,
  type TurnStep,
} from "@guineakub/game-engine";
import { meldSchema, type RoomAction } from "@guineakub/protocol";
import {
  commit,
  digest,
  KeyedQueue,
  type DocumentStore,
} from "./storage/store";
import { ensure } from "./errors";
import type { Actor } from "./auth";
const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const scoreSchema = z.record(z.string(), integer);
const tileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: z.string(), kind: z.literal("joker") }),
  z.strictObject({
    id: z.string(),
    kind: z.literal("number"),
    color: z.enum(["red", "blue", "black", "orange"]),
    value: z.number().int().min(1).max(13),
  }),
]);
const resultSchema = z.strictObject({
  reason: z.enum(["empty-rack", "blocked"]),
  winners: z.array(z.string()).min(1).max(8),
  points: scoreSchema,
});
const gameSchema = z.strictObject({
  id: z.string(),
  revision: integer,
  roundsPlayed: integer,
  playerIds: z.array(z.string()).min(2).max(8),
  scores: scoreSchema,
  round: z
    .strictObject({
      deck: z.array(tileSchema).max(214),
      players: z
        .array(
          z.strictObject({
            id: z.string(),
            rack: z.array(tileSchema).max(214),
            opened: z.boolean(),
          }),
        )
        .min(2)
        .max(8),
      board: z.array(meldSchema).max(72),
      bag: z.array(tileSchema).max(214),
      turnIndex: integer,
      revision: integer,
      consecutivePasses: integer,
      result: resultSchema.nullable(),
    })
    .nullable(),
});
const roomSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  revision: integer,
  originalHost: z.string().uuid(),
  actingHost: z.string().uuid().nullable(),
  members: z
    .array(
      z.strictObject({
        uid: z.string().uuid(),
        name: z.string().min(1).max(80),
      }),
    )
    .min(1)
    .max(8),
  scores: scoreSchema,
  game: gameSchema.nullable(),
  code: z.string().regex(/^[A-Z2-9]{8}$/),
  token: z.string().length(43),
  expiresAt: integer.nullable(),
  lastSeenAt: integer,
  closed: z.boolean(),
  receipts: z
    .array(
      z.strictObject({
        actor: z.string(),
        commandId: z.string(),
        hash: z.string(),
        revision: integer,
      }),
    )
    .max(20_000),
});
type Room = Omit<z.infer<typeof roomSchema>, "game"> & {
  game: GameRoom | null;
};
const DAY = 24 * 60 * 60_000;
const keyOf = (id: string) => {
  ensure(/^[a-f0-9]{64}$/.test(id), "NOT_FOUND", 404);
  return `rooms/${id}.json`;
};
const active = (room: Room) => !!room.game?.round && !room.game.round.result;
export function secureShuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
function validateRoom(value: unknown): Room {
  const room = roomSchema.parse(value) as Room;
  const memberIds = room.members.map((member) => member.uid);
  ensure(
    new Set(memberIds).size === memberIds.length &&
      memberIds.includes(room.originalHost),
    "CORRUPT_ROOM",
    503,
  );
  ensure(
    room.actingHost === null || memberIds.includes(room.actingHost),
    "CORRUPT_ROOM",
    503,
  );
  if (room.game) {
    const game = room.game as GameRoom;
    ensure(
      game.id === room.id &&
        game.playerIds.length === memberIds.length &&
        new Set(game.playerIds).size === memberIds.length &&
        game.playerIds.every((id) => memberIds.includes(id)),
      "CORRUPT_ROOM",
      503,
    );
    if (game.round) {
      assertRoundInventory(game.round);
      ensure(
        game.round.players.every(
          (player) => player.opened || player.rack.length > 0,
        ),
        "CORRUPT_ROOM",
        503,
      );
      if (game.round.result) {
        const expected = scoreRound(
          game.round.players,
          game.round.result.reason,
        );
        ensure(
          JSON.stringify(expected) === JSON.stringify(game.round.result),
          "CORRUPT_ROOM",
          503,
        );
        if (expected.reason === "blocked")
          ensure(
            game.round.bag.length === 0 &&
              game.round.consecutivePasses === memberIds.length,
            "CORRUPT_ROOM",
            503,
          );
      } else
        ensure(
          game.round.players.every((player) => player.rack.length > 0) &&
            game.round.consecutivePasses < memberIds.length,
          "CORRUPT_ROOM",
          503,
        );
      ensure(
        game.playerIds.every((id) => game.scores[id] === room.scores[id]),
        "CORRUPT_ROOM",
        503,
      );
      ensure(
        game.round.players.length === memberIds.length &&
          game.round.players.every((player) => memberIds.includes(player.id)),
        "CORRUPT_ROOM",
        503,
      );
    }
  }
  return room;
}
/** All room writes/reads are serialized, including presence and checkpoint writes. */
export class RoomService {
  private readonly queue = new KeyedQueue();
  private readonly connections = new Map<string, Map<string, Set<string>>>();
  private readonly pendingOfflineAt = new Map<string, number>();
  constructor(
    private readonly store: DocumentStore,
    private readonly now = Date.now,
  ) {}
  private online(id: string) {
    return new Set(
      [...(this.connections.get(id)?.entries() ?? [])]
        .filter(([, connections]) => connections.size > 0)
        .map(([uid]) => uid),
    );
  }
  private chooseHost(room: Room, online: Set<string>) {
    room.actingHost = online.has(room.originalHost)
      ? room.originalHost
      : room.actingHost && online.has(room.actingHost)
        ? room.actingHost
        : ([...online][0] ?? null);
  }
  private isOpen(room: Room) {
    const offlineAt = this.pendingOfflineAt.get(room.id);
    const deadline =
      offlineAt !== undefined && this.online(room.id).size === 0
        ? offlineAt + DAY
        : room.expiresAt;
    ensure(
      !room.closed && (deadline === null || deadline > this.now()),
      "ROOM_EXPIRED",
      410,
    );
  }
  private member(room: Room, actor: Actor) {
    ensure(actor.approved, "APPROVAL_REQUIRED", 403);
    ensure(
      room.members.some((member) => member.uid === actor.uid),
      "NOT_A_MEMBER",
      403,
    );
  }
  private async load(id: string) {
    const document = await this.store.read(keyOf(id));
    ensure(document, "NOT_FOUND", 404);
    return { room: validateRoom(document.value), etag: document.etag };
  }
  private async save(room: Room, etag: string | null) {
    await commit(this.store, keyOf(room.id), validateRoom(room), etag);
  }
  async initialize() {
    for (const key of await this.store.list("rooms/")) {
      const document = await this.store.read(key);
      if (!document) continue;
      const room = validateRoom(document.value);
      ensure(key === keyOf(room.id), "CORRUPT_ROOM", 503);
      // A crash skips disconnect handlers: use the last persisted liveness checkpoint.
      if (room.expiresAt === null) room.expiresAt = room.lastSeenAt + DAY;
      room.actingHost = null;
      if (room.closed || room.expiresAt <= this.now())
        await this.store.delete(key, document.etag);
      else await this.save(room, document.etag);
    }
  }
  async create(actor: Actor, requestId: string) {
    ensure(actor.approved, "APPROVAL_REQUIRED", 403);
    return this.queue.run("creation", async () => {
      const id = digest(`create:${actor.uid}:${requestId}`);
      const existing = await this.store.read(keyOf(id));
      if (existing) {
        const room = validateRoom(existing.value);
        this.isOpen(room);
        return this.view(room, actor);
      }
      const rooms: Room[] = [];
      for (const key of await this.store.list("rooms/")) {
        const doc = await this.store.read(key);
        if (doc) rooms.push(validateRoom(doc.value));
      }
      ensure(
        rooms.filter(
          (room) =>
            room.originalHost === actor.uid &&
            !room.closed &&
            (room.expiresAt === null || room.expiresAt > this.now()),
        ).length < 5,
        "ROOM_LIMIT",
        429,
      );
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code: string;
      do {
        code = Array.from(
          { length: 8 },
          () => alphabet[randomInt(alphabet.length)],
        ).join("");
      } while (rooms.some((room) => room.code === code));
      const room: Room = {
        schemaVersion: 1,
        id,
        revision: 0,
        originalHost: actor.uid,
        actingHost: null,
        members: [{ uid: actor.uid, name: actor.name }],
        scores: { [actor.uid]: 0 },
        game: null,
        code,
        token: randomBytes(32).toString("base64url"),
        expiresAt: this.now() + DAY,
        lastSeenAt: this.now(),
        closed: false,
        receipts: [],
      };
      await this.save(room, null);
      return this.view(room, actor);
    });
  }
  async join(
    actor: Actor,
    invitation: { code: string } | { roomId: string; token: string },
  ) {
    ensure(actor.approved, "APPROVAL_REQUIRED", 403);
    let id: string | undefined;
    if ("code" in invitation) {
      for (const key of await this.store.list("rooms/")) {
        const document = await this.store.read(key);
        if (document) {
          const room = validateRoom(document.value);
          if (room.code === invitation.code) {
            id = room.id;
            break;
          }
        }
      }
    } else id = invitation.roomId;
    ensure(id, "INVALID_INVITATION", 404);
    return this.queue.run(id, async () => {
      const { room, etag } = await this.load(id);
      this.isOpen(room);
      ensure(
        "code" in invitation || digest(invitation.token) === digest(room.token),
        "INVALID_INVITATION",
        404,
      );
      if (!room.members.some((member) => member.uid === actor.uid)) {
        ensure(!active(room), "ROUND_IN_PROGRESS", 409);
        ensure(room.members.length < 8, "ROOM_FULL", 409);
        room.members.push({ uid: actor.uid, name: actor.name });
        room.scores[actor.uid] ??= 0;
        room.game = null;
        room.revision++;
        await this.save(room, etag);
      }
      return this.view(room, actor);
    });
  }
  async snapshot(actor: Actor, id: string) {
    return this.queue.run(id, async () => {
      const { room } = await this.load(id);
      this.isOpen(room);
      this.member(room, actor);
      return this.view(room, actor);
    });
  }
  private view(room: Room, actor: Actor) {
    this.member(room, actor);
    const round = room.game?.round;
    return {
      id: room.id,
      revision: room.revision,
      originalHost: room.originalHost,
      actingHost: room.actingHost,
      members: room.members.map((member) => ({
        ...member,
        connected: this.online(room.id).has(member.uid),
        score: room.scores[member.uid] ?? 0,
      })),
      phase: active(room) ? ("playing" as const) : ("lobby" as const),
      invitation: { code: room.code, token: room.token },
      round: round
        ? {
            revision: round.revision,
            board: round.board,
            turnPlayerId: round.players[round.turnIndex]!.id,
            bagCount: round.bag.length,
            rack: round.players.find((player) => player.id === actor.uid)!.rack,
            players: round.players.map((player) => ({
              id: player.id,
              rackCount: player.rack.length,
              opened: player.opened,
            })),
            result: round.result,
          }
        : null,
    };
  }
  async presence(
    actor: Actor,
    id: string,
    connectionId: string,
    connected: boolean,
  ) {
    return this.queue.run(id, async () => {
      if (!connected) {
        const existing = this.connections.get(id)?.get(actor.uid);
        if (!existing?.has(connectionId)) return;
        existing.delete(connectionId);
        if (this.online(id).size === 0)
          this.pendingOfflineAt.set(id, this.now());
      }
      const { room, etag } = await this.load(id);
      this.isOpen(room);
      this.member(room, actor);
      const next = structuredClone(
        this.connections.get(id) ?? new Map<string, Set<string>>(),
      );
      const sockets = next.get(actor.uid) ?? new Set<string>();
      if (connected) sockets.add(connectionId);
      else sockets.delete(connectionId);
      next.set(actor.uid, sockets);
      const online = new Set(
        [...next].filter(([, value]) => value.size > 0).map(([uid]) => uid),
      );
      room.lastSeenAt = this.now();
      room.expiresAt = online.size
        ? null
        : (this.pendingOfflineAt.get(id) ?? this.now()) + DAY;
      this.chooseHost(room, online);
      await this.save(room, etag);
      this.connections.set(id, next);
      this.pendingOfflineAt.delete(id);
    });
  }
  async checkpoint() {
    const changedHosts: string[] = [];
    for (const key of await this.store.list("rooms/")) {
      const id = key.slice(6, -5);
      await this.queue.run(id, async () => {
        const document = await this.store.read(key);
        if (!document) return;
        const room = validateRoom(document.value);
        if (
          room.closed ||
          (room.expiresAt !== null && room.expiresAt <= this.now())
        ) {
          await this.store.delete(key, document.etag);
          this.connections.delete(id);
          return;
        }
        const online = this.online(id);
        const previousHost = room.actingHost;
        this.chooseHost(room, online);
        if (online.size > 0) {
          room.lastSeenAt = this.now();
          await this.save(room, document.etag);
          if (previousHost !== room.actingHost) changedHosts.push(id);
        } else if (room.expiresAt === null || this.pendingOfflineAt.has(id)) {
          room.expiresAt =
            (this.pendingOfflineAt.get(id) ?? room.lastSeenAt) + DAY;
          await this.save(room, document.etag);
          this.pendingOfflineAt.delete(id);
        }
      });
    }
    return changedHosts;
  }
  async command(
    actor: Actor,
    id: string,
    commandId: string,
    expectedRevision: number,
    action: RoomAction,
  ) {
    return this.queue.run(id, async () => {
      const { room, etag } = await this.load(id);
      this.member(room, actor);
      const hash = digest(JSON.stringify({ expectedRevision, action }));
      const receipt = room.receipts.find(
        (receipt) =>
          receipt.actor === actor.uid && receipt.commandId === commandId,
      );
      if (receipt) {
        ensure(receipt.hash === hash, "COMMAND_ID_REUSED", 409);
        return {
          revision: receipt.revision,
          duplicate: true,
          closed: room.closed,
        };
      }
      this.isOpen(room);
      ensure(this.online(id).has(actor.uid), "SUBSCRIBE_FIRST", 403);
      ensure(expectedRevision === room.revision, "STALE_REVISION", 409);
      ensure(
        room.receipts.length < 20_000 || action.type === "end",
        "COMMAND_LIMIT",
        429,
      );
      this.chooseHost(room, this.online(id));
      const host = () =>
        ensure(room.actingHost === actor.uid, "HOST_REQUIRED", 403);
      switch (action.type) {
        case "start": {
          host();
          ensure(!active(room), "ROUND_IN_PROGRESS", 409);
          ensure(room.members.length >= 2, "NEED_MORE_PLAYERS", 409);
          const ids = room.members.map((member) => member.uid);
          const base = {
            ...createGameRoom(id, ids),
            scores: { ...room.scores },
            roundsPlayed: room.game?.roundsPlayed ?? 0,
          };
          room.game = startRoomRound(
            base,
            base.revision,
            secureShuffle(ids),
            secureShuffle(createDeck(deckConfigForPlayers(ids.length))),
          );
          break;
        }
        case "abandon":
          host();
          ensure(active(room), "NO_ACTIVE_ROUND", 409);
          room.game = null;
          break;
        case "end":
          host();
          room.receipts = [];
          room.closed = true;
          room.game = null;
          room.scores = {};
          room.expiresAt = this.now();
          break;
        case "remove-player": {
          host();
          ensure(!active(room), "ROUND_IN_PROGRESS", 409);
          // Host identity must remain in the room to preserve reconnect/reversion.
          ensure(
            action.playerId !== room.originalHost &&
              action.playerId !== actor.uid,
            "CANNOT_REMOVE_HOST",
            409,
          );
          ensure(
            room.members.some((member) => member.uid === action.playerId),
            "NOT_A_MEMBER",
            404,
          );
          room.members = room.members.filter(
            (member) => member.uid !== action.playerId,
          );
          room.game = null;
          break;
        }
        case "reset-scores":
          ensure(!active(room), "ROUND_IN_PROGRESS", 409);
          room.scores = Object.fromEntries(
            Object.keys(room.scores).map((id) => [id, 0]),
          );
          if (room.game)
            room.game = resetRoomScores(
              room.game as GameRoom,
              actor.uid,
              room.game.revision,
            );
          break;
        case "draw":
        case "pass":
        case "play": {
          ensure(room.game && active(room), "NO_ACTIVE_ROUND", 409);
          const command =
            action.type === "play"
              ? {
                  type: "play" as const,
                  steps: action.steps as TurnStep[],
                  playerId: actor.uid,
                  expectedRevision: action.expectedRoundRevision,
                }
              : {
                  type: action.type,
                  playerId: actor.uid,
                  expectedRevision: action.expectedRoundRevision,
                };
          const result = applyRoomCommand(
            room.game as GameRoom,
            room.game.revision,
            command,
          );
          ensure(result.ok, result.ok ? "INVALID_PLAY" : result.code, 409);
          room.game = result.room;
          room.scores = { ...room.scores, ...result.room.scores };
          break;
        }
      }
      room.revision++;
      room.receipts.push({
        actor: actor.uid,
        commandId,
        hash,
        revision: room.revision,
      });
      await this.save(room, etag);
      if (action.type === "end") this.connections.delete(id);
      if (action.type === "remove-player")
        this.connections.get(id)?.delete(action.playerId);
      return { revision: room.revision, duplicate: false, closed: room.closed };
    });
  }
}
export type RoomView = Awaited<ReturnType<RoomService["snapshot"]>>;
