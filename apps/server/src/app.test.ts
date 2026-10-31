import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  serverMessageSchema,
  type ServerMessage,
} from "@guineakub/protocol";
import { createApplication } from "./app";
import { MemoryStore } from "./storage/store";
const origin = "http://localhost:5173";
class FaultStore extends MemoryStore {
  fail = false;
  override async write(key: string, value: unknown, expected: string | null) {
    if (this.fail)
      throw new Error("Synthetic storage failure containing no user data");
    return super.write(key, value, expected);
  }
}
let app: Awaited<ReturnType<typeof createApplication>>;
let base: string;
let store: FaultStore;
const logs: unknown[] = [];
async function boot() {
  app = await createApplication({
    store,
    allowedOrigins: [origin],
    secureCookies: false,
    ownerSub: "owner",
    verifyGoogle: async (credential) => ({
      sub: credential,
      name: "Synthetic user",
    }),
    log: (event) => logs.push(event),
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
beforeEach(async () => {
  store = new FaultStore();
  logs.length = 0;
  await boot();
});
afterEach(async () => {
  store.fail = false;
  await app.close();
});
async function login(subject: string) {
  const challenge = await fetch(`${base}/auth/nonce`, { headers: { origin } });
  const challengeCookie = challenge.headers.getSetCookie()[0]!.split(";")[0]!;
  const nonce = (await challenge.json()) as { nonce: string };
  expect(nonce.nonce.length).toBeGreaterThan(20);
  const response = await fetch(`${base}/auth/google`, {
    method: "POST",
    headers: {
      origin,
      cookie: challengeCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ credential: subject }),
  });
  expect(response.status).toBe(200);
  const actor = (await response.json()) as {
    uid: string;
    approved: boolean;
    admin: boolean;
  };
  const cookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("gk-session="))!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  return { cookie: cookie.split(";")[0]!, actor };
}
async function family() {
  const owner = await login("owner");
  const player = await login("player");
  const approval = await fetch(`${base}/admin/approve`, {
    method: "POST",
    headers: {
      origin,
      cookie: owner.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ uid: player.actor.uid }),
  });
  expect(approval.status).toBe(200);
  return { owner, player };
}
class Client {
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: {
    test: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = serverMessageSchema.parse(JSON.parse(data.toString()));
      const index = this.waiters.findIndex((waiter) => waiter.test(message));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(message);
      else this.queue.push(message);
    });
  }
  send(value: object) {
    this.socket.send(JSON.stringify({ version: PROTOCOL_VERSION, ...value }));
  }
  next(test: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const index = this.queue.findIndex(test);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        test,
        resolve: (message: ServerMessage) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for server message"));
      }, 3000);
      this.waiters.push(waiter);
    });
  }
  async request(requestId: string, value: object) {
    this.send({ requestId, ...value });
    return this.next((message) => message.requestId === requestId);
  }
}
async function connect(cookie: string) {
  const socket = new WebSocket(base.replace("http", "ws") + "/ws", {
    headers: { origin, cookie },
  });
  const client = new Client(socket);
  await once(socket, "open");
  return client;
}
async function rejectedSocket(cookie: string, requestOrigin = origin) {
  const socket = new WebSocket(base.replace("http", "ws") + "/ws", {
    headers: { origin: requestOrigin, cookie },
  });
  socket.on("error", () => undefined);
  const [request, response] = await once(socket, "unexpected-response");
  response.resume();
  request.destroy();
  return response.statusCode as number;
}
it("requires sessions, approvals and exact origins for HTTP and WebSocket access", async () => {
  const health = await fetch(`${base}/health`);
  expect(health.status).toBe(200);
  expect(await rejectedSocket("")).toBe(401);
  const pending = await login("pending");
  expect(await rejectedSocket(pending.cookie)).toBe(403);
  const owner = await login("owner");
  expect(await rejectedSocket(owner.cookie, "https://evil.invalid")).toBe(403);
  const denied = await fetch(`${base}/admin/accounts`, {
    headers: { origin, cookie: pending.cookie },
  });
  expect(denied.status).toBe(403);
  const csrf = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: "https://evil.invalid", cookie: owner.cookie },
  });
  expect(csrf.status).toBe(403);
  const noChallenge = await fetch(`${base}/auth/google`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ credential: "owner" }),
  });
  expect(noChallenge.status).toBe(401);
});
it("routes private snapshots, idempotent commands and authenticated reconnect after a server restart", async () => {
  const { owner, player } = await family();
  const a = await connect(owner.cookie);
  const b = await connect(player.cookie);
  const created = await a.request("create", { type: "create-room" });
  if (created.type !== "snapshot") throw new Error("Expected snapshot");
  const joined = await b.request("join", {
    type: "join-code",
    code: created.room.invitation.code,
  });
  if (joined.type !== "snapshot") throw new Error("Expected snapshot");
  const id = joined.room.id;
  const start = await a.request("start", {
    type: "room-command",
    roomId: id,
    commandId: "start",
    expectedRevision: joined.room.revision,
    action: { type: "start" },
  });
  expect(start.type).toBe("ack");
  const aState = await a.next(
    (message) => message.type === "snapshot" && message.room.round !== null,
  );
  const bState = await b.next(
    (message) => message.type === "snapshot" && message.room.round !== null,
  );
  if (aState.type !== "snapshot" || bState.type !== "snapshot")
    throw new Error("Expected snapshot");
  for (const tile of bState.room.round!.rack)
    expect(JSON.stringify(aState)).not.toContain(`"${tile.id}"`);
  expect(aState.room.round).not.toHaveProperty("bag");
  expect(aState.room.round).not.toHaveProperty("deck");
  const current = aState.room.round!.turnPlayerId === owner.actor.uid ? a : b;
  const command = {
    type: "room-command",
    roomId: id,
    commandId: "draw-once",
    expectedRevision: aState.room.revision,
    action: {
      type: "draw",
      expectedRoundRevision: aState.room.round!.revision,
    },
  };
  const first = await current.request("draw", command);
  expect(first).toMatchObject({ type: "ack", duplicate: false });
  const retry = await current.request("retry", command);
  expect(retry).toMatchObject({ type: "ack", duplicate: true });
  const before = await app.rooms.snapshot(
    await app.auth!.authenticate(owner.cookie.split("=")[1]!),
    id,
  );
  await app.close();
  await boot();
  const reconnected = await connect(owner.cookie);
  const recovered = await reconnected.request("resume", {
    type: "subscribe-room",
    roomId: id,
  });
  if (recovered.type !== "snapshot") throw new Error("Expected snapshot");
  expect(recovered.room.round).toEqual(before.round);
  expect(recovered.room.actingHost).toBe(owner.actor.uid);
});
it("emits no success or candidate snapshot when durable persistence fails", async () => {
  const { owner, player } = await family();
  const a = await connect(owner.cookie);
  const b = await connect(player.cookie);
  const created = await a.request("create", { type: "create-room" });
  if (created.type !== "snapshot") throw new Error("Expected snapshot");
  const joined = await b.request("join", {
    type: "join-link",
    roomId: created.room.id,
    token: created.room.invitation.token,
  });
  if (joined.type !== "snapshot") throw new Error("Expected snapshot");
  store.fail = true;
  const result = await a.request("failed-start", {
    type: "room-command",
    roomId: created.room.id,
    commandId: "start",
    expectedRevision: joined.room.revision,
    action: { type: "start" },
  });
  expect(result).toMatchObject({ type: "error", code: "SERVICE_UNAVAILABLE" });
  const actor = await app.auth!.authenticate(owner.cookie.split("=")[1]!);
  expect((await app.rooms.snapshot(actor, created.room.id)).phase).toBe(
    "lobby",
  );
  expect(JSON.stringify(logs)).not.toContain(owner.cookie);
  store.fail = false;
});
it("rejects malformed/authoritative-state messages and revokes a live socket on logout", async () => {
  const owner = await login("owner");
  const client = await connect(owner.cookie);
  client.socket.send("{invalid");
  expect(
    await client.next((message) => message.type === "error"),
  ).toMatchObject({ code: "INVALID_MESSAGE" });
  client.send({ type: "create-room", requestId: "x", authoritativeState: {} });
  expect(
    await client.next((message) => message.type === "error"),
  ).toMatchObject({ code: "INVALID_MESSAGE" });
  const closed = once(client.socket, "close");
  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin, cookie: owner.cookie },
  });
  expect(logout.status).toBe(200);
  await closed;
  expect(await rejectedSocket(owner.cookie)).toBe(401);
});
it("rate limits unauthenticated enrollment attempts without exposing input", async () => {
  let status = 0;
  for (let i = 0; i < 61; i++) {
    const response = await fetch(`${base}/auth/nonce`, { headers: { origin } });
    status = response.status;
    await response.arrayBuffer();
  }
  expect(status).toBe(429);
});
it("sets host-only Secure production cookies without exposing session credentials in JSON", async () => {
  await app.close();
  app = await createApplication({
    store,
    allowedOrigins: [origin],
    secureCookies: true,
    ownerSub: "owner",
    verifyGoogle: async (sub) => ({ sub, name: "Synthetic owner" }),
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const challenge = await fetch(`${base}/auth/nonce`, { headers: { origin } });
  const cookie = challenge.headers.getSetCookie()[0]!;
  expect(cookie).toContain("__Host-gk-login=");
  expect(cookie).toContain("Secure");
  expect(cookie).not.toContain("Domain=");
  await challenge.arrayBuffer();
  const response = await fetch(`${base}/auth/google`, {
    method: "POST",
    headers: {
      origin,
      cookie: cookie.split(";")[0]!,
      "content-type": "application/json",
    },
    body: JSON.stringify({ credential: "owner" }),
  });
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-gk-session="))!;
  expect(session).toContain("Secure");
  expect(session).toContain("HttpOnly");
  expect(session).not.toContain("Domain=");
  const json = (await response.json()) as Record<string, unknown>;
  expect(json).not.toHaveProperty("token");
  expect(json).not.toHaveProperty("sub");
});
it("fails closed without OAuth/admin configuration and rejects oversized JSON requests", async () => {
  await app.close();
  app = await createApplication({
    store,
    allowedOrigins: [origin],
    secureCookies: false,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  expect((await fetch(`${base}/ready`)).status).toBe(503);
  expect(
    (await fetch(`${base}/auth/nonce`, { headers: { origin } })).status,
  ).toBe(503);
  await app.close();
  await boot();
  const huge = await fetch(`${base}/auth/google`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ credential: "x".repeat(300_000) }),
  });
  expect(huge.status).toBe(413);
});
