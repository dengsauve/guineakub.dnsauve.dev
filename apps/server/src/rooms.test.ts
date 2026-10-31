import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoomService } from "./rooms";
import { MemoryStore, type DocumentStore } from "./storage/store";
import { FileStore } from "./storage/file";
import type { Actor } from "./auth";
function actor(): Actor {
  return {
    uid: randomUUID(),
    name: "Synthetic player",
    approved: true,
    admin: false,
    expiresAt: Date.now() + 3600_000,
  };
}
async function setup(
  count: number,
  store: DocumentStore = new MemoryStore(),
  clock = Date.now,
) {
  const service = new RoomService(store, clock);
  await service.initialize();
  const actors = Array.from({ length: count }, actor);
  const room = await service.create(actors[0]!, "create");
  for (const player of actors.slice(1))
    await service.join(player, { code: room.invitation.code });
  for (const player of actors)
    await service.presence(player, room.id, player.uid, true);
  return { store, service, actors, id: room.id, host: actors[0]! };
}
async function start(context: Awaited<ReturnType<typeof setup>>) {
  const view = await context.service.snapshot(context.host, context.id);
  await context.service.command(
    context.host,
    context.id,
    "start",
    view.revision,
    { type: "start" },
  );
  return context.service.snapshot(context.host, context.id);
}
it.each([2, 4, 6, 8])(
  "protects private racks/bag and persists idempotent commands for %i members",
  async (count) => {
    const ctx = await setup(count);
    await start(ctx);
    const views = await Promise.all(
      ctx.actors.map((player) => ctx.service.snapshot(player, ctx.id)),
    );
    for (const [index, view] of views.entries()) {
      expect(view.round?.rack).toHaveLength(14);
      expect(view.round).not.toHaveProperty("bag");
      expect(view.round).not.toHaveProperty("deck");
      expect(view.round?.players.every((player) => !("rack" in player))).toBe(
        true,
      );
      for (const other of views.filter(
        (_, otherIndex) => index !== otherIndex,
      )) {
        for (const tile of other.round!.rack)
          expect(JSON.stringify(view)).not.toContain(`"${tile.id}"`);
      }
    }
    const view = views[0]!;
    const current = ctx.actors.find(
      (player) => player.uid === view.round!.turnPlayerId,
    )!;
    const action = {
      type: "draw" as const,
      expectedRoundRevision: view.round!.revision,
    };
    const first = await ctx.service.command(
      current,
      ctx.id,
      "draw-once",
      view.revision,
      action,
    );
    expect(first.duplicate).toBe(false);
    const duplicate = await ctx.service.command(
      current,
      ctx.id,
      "draw-once",
      view.revision,
      action,
    );
    expect(duplicate).toMatchObject({
      duplicate: true,
      revision: first.revision,
    });
    const after = await ctx.service.snapshot(current, ctx.id);
    expect(after.round!.bagCount).toBe(view.round!.bagCount - 1);
    expect(after.round!.rack).toHaveLength(15);
    await expect(
      ctx.service.command(current, ctx.id, "draw-once", view.revision, {
        type: "pass",
        expectedRoundRevision: action.expectedRoundRevision,
      }),
    ).rejects.toThrow("COMMAND_ID_REUSED");
    await expect(
      ctx.service.command(current, ctx.id, "stale", view.revision, action),
    ).rejects.toThrow("STALE_REVISION");
    const restarted = new RoomService(ctx.store);
    await restarted.initialize();
    await restarted.presence(current, ctx.id, "new-socket", true);
    expect((await restarted.snapshot(current, ctx.id)).round).toEqual(
      after.round,
    );
    expect(
      await restarted.command(
        current,
        ctx.id,
        "draw-once",
        view.revision,
        action,
      ),
    ).toMatchObject({ duplicate: true });
  },
);
it("enforces approval, membership, invitation secrets, capacity and host privileges", async () => {
  const ctx = await setup(8);
  const room = await ctx.service.snapshot(ctx.host, ctx.id);
  await expect(
    ctx.service.create({ ...actor(), approved: false }, "x"),
  ).rejects.toThrow("APPROVAL_REQUIRED");
  await expect(ctx.service.snapshot(actor(), ctx.id)).rejects.toThrow(
    "NOT_A_MEMBER",
  );
  await expect(
    ctx.service.join(actor(), { roomId: ctx.id, token: "wrong" }),
  ).rejects.toThrow("INVALID_INVITATION");
  await expect(
    ctx.service.join(actor(), { code: room.invitation.code }),
  ).rejects.toThrow("ROOM_FULL");
  await expect(
    ctx.service.command(ctx.actors[1]!, ctx.id, "start", room.revision, {
      type: "start",
    }),
  ).rejects.toThrow("HOST_REQUIRED");
  await start(ctx);
  const current = await ctx.service.snapshot(ctx.host, ctx.id);
  await expect(
    ctx.service.command(ctx.host, ctx.id, "remove", current.revision, {
      type: "remove-player",
      playerId: ctx.actors[1]!.uid,
    }),
  ).rejects.toThrow("ROUND_IN_PROGRESS");
  await expect(
    ctx.service.command(ctx.host, ctx.id, "reset", current.revision, {
      type: "reset-scores",
    }),
  ).rejects.toThrow("ROUND_IN_PROGRESS");
});
it("transfers host controls, reverts to original host, and counts multiple tabs without skipping turns", async () => {
  const ctx = await setup(3);
  const before = await start(ctx);
  await ctx.service.presence(ctx.host, ctx.id, "second-tab", true);
  await ctx.service.presence(ctx.host, ctx.id, ctx.host.uid, false);
  expect((await ctx.service.snapshot(ctx.host, ctx.id)).actingHost).toBe(
    ctx.host.uid,
  );
  await ctx.service.presence(ctx.host, ctx.id, "second-tab", false);
  const temporary = await ctx.service.snapshot(ctx.actors[1]!, ctx.id);
  expect(temporary.actingHost).not.toBe(ctx.host.uid);
  expect(temporary.round!.turnPlayerId).toBe(before.round!.turnPlayerId);
  await ctx.service.presence(ctx.host, ctx.id, "returned", true);
  expect((await ctx.service.snapshot(ctx.host, ctx.id)).actingHost).toBe(
    ctx.host.uid,
  );
});
it("allows lobby removal, abandonment without scoring, reset by nonhost and end game night", async () => {
  const ctx = await setup(3);
  let view = await ctx.service.snapshot(ctx.host, ctx.id);
  await ctx.service.command(ctx.host, ctx.id, "remove", view.revision, {
    type: "remove-player",
    playerId: ctx.actors[2]!.uid,
  });
  await expect(ctx.service.snapshot(ctx.actors[2]!, ctx.id)).rejects.toThrow(
    "NOT_A_MEMBER",
  );
  view = await start(ctx);
  await ctx.service.command(ctx.host, ctx.id, "abandon", view.revision, {
    type: "abandon",
  });
  view = await ctx.service.snapshot(ctx.host, ctx.id);
  expect(view.phase).toBe("lobby");
  expect(view.round).toBeNull();
  expect(view.members.every((player) => player.score === 0)).toBe(true);
  await ctx.service.command(ctx.actors[1]!, ctx.id, "reset", view.revision, {
    type: "reset-scores",
  });
  view = await ctx.service.snapshot(ctx.host, ctx.id);
  await ctx.service.command(ctx.host, ctx.id, "end", view.revision, {
    type: "end",
  });
  await expect(ctx.service.snapshot(ctx.host, ctx.id)).rejects.toThrow(
    "ROOM_EXPIRED",
  );
  await expect(
    ctx.service.join(actor(), { code: view.invitation.code }),
  ).rejects.toThrow("ROOM_EXPIRED");
});
it("expires after 24 hours offline, cancels expiry on reconnect and does not extend it on restarts", async () => {
  let now = Date.now();
  const clock = () => now;
  const ctx = await setup(2, new MemoryStore(), clock);
  for (const player of ctx.actors)
    await ctx.service.presence(player, ctx.id, player.uid, false);
  now += 23 * 3600_000;
  await ctx.service.presence(ctx.host, ctx.id, "reconnect", true);
  now += 2 * 3600_000;
  await expect(ctx.service.snapshot(ctx.host, ctx.id)).resolves.toHaveProperty(
    "id",
    ctx.id,
  );
  await ctx.service.checkpoint();
  now += 1000;
  const restart = new RoomService(ctx.store, clock);
  await restart.initialize();
  now += 23 * 3600_000;
  const again = new RoomService(ctx.store, clock);
  await again.initialize();
  now += 3600_000;
  await expect(again.snapshot(ctx.host, ctx.id)).rejects.toThrow(
    "ROOM_EXPIRED",
  );
  await again.checkpoint();
  expect(await ctx.store.list("rooms/")).toHaveLength(0);
});
it("recovers a file-backed game using a new store/service instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "guineakub-recovery-"));
  try {
    const ctx = await setup(2, new FileStore(root));
    const before = await start(ctx);
    const service = new RoomService(new FileStore(root));
    await service.initialize();
    expect((await service.snapshot(ctx.host, ctx.id)).round).toEqual(
      before.round,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("never accepts failed persistence and reconciles a write committed before its response was lost", async () => {
  class FailingStore extends MemoryStore {
    failure: "before" | "after" | null = null;
    override async write(key: string, value: unknown, expected: string | null) {
      if (this.failure === "before") throw new Error("storage unavailable");
      await super.write(key, value, expected);
      if (this.failure === "after") {
        this.failure = null;
        throw new Error("response lost");
      }
    }
  }
  const store = new FailingStore();
  const ctx = await setup(2, store);
  const before = await ctx.service.snapshot(ctx.host, ctx.id);
  store.failure = "before";
  await expect(
    ctx.service.command(ctx.host, ctx.id, "start", before.revision, {
      type: "start",
    }),
  ).rejects.toThrow();
  expect((await ctx.service.snapshot(ctx.host, ctx.id)).revision).toBe(
    before.revision,
  );
  store.failure = "after";
  expect(
    await ctx.service.command(ctx.host, ctx.id, "start", before.revision, {
      type: "start",
    }),
  ).toMatchObject({ duplicate: false, revision: before.revision + 1 });
  expect(
    await ctx.service.command(ctx.host, ctx.id, "start", before.revision, {
      type: "start",
    }),
  ).toMatchObject({ duplicate: true });
});
it("serializes competing commands at one revision and rejects corrupt recovered snapshots", async () => {
  const ctx = await setup(2);
  const view = await ctx.service.snapshot(ctx.host, ctx.id);
  const results = await Promise.allSettled(
    ["one", "two"].map((commandId) =>
      ctx.service.command(ctx.host, ctx.id, commandId, view.revision, {
        type: "start",
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const document = await ctx.store.read(`rooms/${ctx.id}.json`);
  await ctx.store.write(
    `rooms/${ctx.id}.json`,
    { schemaVersion: 99 },
    document!.etag,
  );
  await expect(new RoomService(ctx.store).initialize()).rejects.toThrow();
});
it("does not keep a ghost host or extend an offline room indefinitely after disconnect persistence fails", async () => {
  let now = Date.now();
  class FailingStore extends MemoryStore {
    fail = false;
    override async write(key: string, value: unknown, expected: string | null) {
      if (this.fail) throw new Error("unavailable");
      return super.write(key, value, expected);
    }
  }
  const store = new FailingStore();
  const ctx = await setup(2, store, () => now);
  store.fail = true;
  await expect(
    ctx.service.presence(ctx.host, ctx.id, ctx.host.uid, false),
  ).rejects.toThrow();
  store.fail = false;
  const view = await ctx.service.snapshot(ctx.actors[1]!, ctx.id);
  await ctx.service.command(ctx.actors[1]!, ctx.id, "takeover", view.revision, {
    type: "start",
  });
  expect((await ctx.service.snapshot(ctx.actors[1]!, ctx.id)).actingHost).toBe(
    ctx.actors[1]!.uid,
  );
  store.fail = true;
  await expect(
    ctx.service.presence(ctx.actors[1]!, ctx.id, ctx.actors[1]!.uid, false),
  ).rejects.toThrow();
  store.fail = false;
  now += 60_000;
  await ctx.service.checkpoint();
  now += 24 * 3600_000;
  await expect(ctx.service.snapshot(ctx.host, ctx.id)).rejects.toThrow(
    "ROOM_EXPIRED",
  );
});
it("rejects late reconnect before the cleanup sweep if offline persistence previously failed", async () => {
  let now = Date.now();
  class FailingStore extends MemoryStore {
    fail = false;
    override async write(key: string, value: unknown, expected: string | null) {
      if (this.fail) throw new Error("unavailable");
      return super.write(key, value, expected);
    }
  }
  const store = new FailingStore();
  const ctx = await setup(2, store, () => now);
  store.fail = true;
  for (const player of ctx.actors)
    await expect(
      ctx.service.presence(player, ctx.id, player.uid, false),
    ).rejects.toThrow();
  now += 24 * 3600_000 + 1;
  store.fail = false;
  await expect(
    ctx.service.presence(ctx.host, ctx.id, "too-late", true),
  ).rejects.toThrow("ROOM_EXPIRED");
});
