import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
} from "@guineakub/protocol";
import { AuthService, type Actor, type VerifyGoogle } from "./auth";
import { RoomService } from "./rooms";
import { ensure, ServiceError } from "./errors";
import { digest, type DocumentStore } from "./storage/store";
const BODY_LIMIT = 256 * 1024;
class RateLimit {
  private readonly counters = new Map<
    string,
    { count: number; until: number }
  >();
  take(key: string, limit: number) {
    const now = Date.now();
    for (const [key, value] of this.counters)
      if (value.until <= now) this.counters.delete(key);
    const entry = this.counters.get(key) ?? { count: 0, until: now + 60_000 };
    ensure(this.counters.size < 10_000, "RATE_LIMITED", 429);
    this.counters.set(key, entry);
    ensure(++entry.count <= limit, "RATE_LIMITED", 429);
  }
}
function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s).slice(0, 2))
      .filter((parts) => parts.length === 2),
  );
}
async function body(request: IncomingMessage): Promise<unknown> {
  ensure(
    request.headers["content-type"]?.split(";")[0] === "application/json",
    "JSON_REQUIRED",
    415,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    ensure(size <= BODY_LIMIT, "PAYLOAD_TOO_LARGE", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ServiceError("INVALID_JSON");
  }
}
interface Options {
  store: DocumentStore;
  allowedOrigins: readonly string[];
  secureCookies: boolean;
  verifyGoogle?: VerifyGoogle;
  ownerSub?: string;
  now?: () => number;
  log?: (event: { event: string; code: string }) => void;
}
interface Connection {
  socket: WebSocket;
  id: string;
  token: string;
  actor: Actor;
  roomId: string | null;
  alive: boolean;
  pending: Promise<void>;
  queued: number;
  cleaned: boolean;
}
export async function createApplication(options: Options) {
  const now = options.now ?? Date.now;
  const rooms = new RoomService(options.store, now);
  await rooms.initialize();
  const auth =
    options.verifyGoogle && options.ownerSub
      ? new AuthService(
          options.store,
          options.verifyGoogle,
          options.ownerSub,
          now,
        )
      : null;
  const rates = new RateLimit();
  const connections = new Set<Connection>();
  const cookieName = options.secureCookies ? "__Host-gk-session" : "gk-session";
  const nonceCookie = options.secureCookies ? "__Host-gk-login" : "gk-login";
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${options.secureCookies ? "; Secure" : ""}`;
  const log = options.log ?? (() => undefined);
  const requiredAuth = () => {
    ensure(auth, "AUTH_NOT_CONFIGURED", 503);
    return auth;
  };
  const origin = (request: IncomingMessage) =>
    ensure(
      typeof request.headers.origin === "string" &&
        options.allowedOrigins.includes(request.headers.origin),
      "ORIGIN_DENIED",
      403,
    );
  const token = (request: IncomingMessage) =>
    cookies(request)[cookieName] ?? "";
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  async function http(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const path = request.url;
    if (request.method === "GET" && path === "/health") {
      json(response, 200, { status: "ok", protocolVersion: PROTOCOL_VERSION });
      return;
    }
    if (request.method === "GET" && path === "/ready") {
      json(response, auth ? 200 : 503, { ready: !!auth });
      return;
    }
    origin(request);
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin!);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
    rates.take(`http:${request.socket.remoteAddress}`, 60);
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.writeHead(204);
      response.end();
      return;
    }
    const authService = requiredAuth();
    if (request.method === "GET" && path === "/auth/nonce") {
      const challenge = authService.challenge();
      response.setHeader("Set-Cookie", cookie(nonceCookie, challenge.key, 300));
      json(response, 200, { nonce: challenge.nonce });
      return;
    }
    if (request.method === "POST" && path === "/auth/google") {
      const input = z
        .strictObject({ credential: z.string().min(1).max(16_384) })
        .parse(await body(request));
      const result = await authService.login(
        cookies(request)[nonceCookie] ?? "",
        input.credential,
      );
      response.setHeader("Set-Cookie", [
        cookie(cookieName, result.token, 12 * 3600),
        cookie(nonceCookie, "", 0),
      ]);
      json(response, 200, result.actor);
      return;
    }
    if (request.method === "POST" && path === "/auth/logout") {
      await authService.logout(token(request));
      for (const connection of connections)
        if (connection.token === token(request))
          connection.socket.close(1008, "Signed out");
      response.setHeader("Set-Cookie", cookie(cookieName, "", 0));
      json(response, 200, { ok: true });
      return;
    }
    const actor = await authService.authenticate(token(request));
    if (request.method === "GET" && path === "/auth/me") {
      json(response, 200, actor);
      return;
    }
    if (request.method === "GET" && path === "/admin/accounts") {
      json(response, 200, { accounts: await authService.listAccounts(actor) });
      return;
    }
    if (request.method === "POST" && path === "/admin/approve") {
      const input = z
        .strictObject({ uid: z.string().uuid() })
        .parse(await body(request));
      await authService.approve(actor, input.uid);
      json(response, 200, { ok: true });
      return;
    }
    json(response, 404, { code: "NOT_FOUND" });
  }
  const server = createServer((request, response) => {
    void http(request, response).catch((error) => {
      const status =
        error instanceof ServiceError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 503;
      const code =
        error instanceof ServiceError
          ? error.code
          : error instanceof z.ZodError
            ? "INVALID_REQUEST"
            : "SERVICE_UNAVAILABLE";
      if (status >= 500) log({ event: "http_failure", code });
      if (!response.headersSent) json(response, status, { code });
      else response.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: BODY_LIMIT,
    perMessageDeflate: false,
  });
  function send(connection: Connection, value: unknown) {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 1024 * 1024) {
      connection.socket.close(1008, "Slow connection");
      return;
    }
    try {
      connection.socket.send(
        JSON.stringify(
          serverMessageSchema.parse({
            version: PROTOCOL_VERSION,
            ...(value as object),
          }),
        ),
      );
    } catch {
      log({ event: "invalid_response", code: "SERVICE_UNAVAILABLE" });
      connection.socket.terminate();
    }
  }
  async function broadcast(id: string, closed = false) {
    await Promise.all(
      [...connections]
        .filter((connection) => connection.roomId === id)
        .map(async (connection) => {
          try {
            const actor = await requiredAuth().authenticate(connection.token);
            ensure(actor.approved, "APPROVAL_REQUIRED", 403);
            if (closed) {
              send(connection, { type: "room-closed", requestId: null });
              connection.socket.close(1000, "Game night ended");
              return;
            }
            send(connection, {
              type: "snapshot",
              requestId: null,
              room: await rooms.snapshot(actor, id),
            });
          } catch (error) {
            if (
              error instanceof ServiceError &&
              [401, 403, 404, 410].includes(error.status)
            )
              connection.socket.close(1008, "Room unavailable");
            else
              log({ event: "broadcast_failure", code: "SERVICE_UNAVAILABLE" });
          }
        }),
    );
  }
  async function cleanup(connection: Connection) {
    if (connection.cleaned) return;
    connection.cleaned = true;
    connections.delete(connection);
    if (connection.roomId) {
      try {
        await rooms.presence(
          connection.actor,
          connection.roomId,
          connection.id,
          false,
        );
        await broadcast(connection.roomId);
      } catch {
        log({ event: "disconnect_update_failed", code: "SERVICE_UNAVAILABLE" });
      }
    }
  }
  async function subscribe(
    connection: Connection,
    id: string,
    requestId: string,
  ) {
    ensure(
      connection.roomId === null || connection.roomId === id,
      "ONE_ROOM_PER_CONNECTION",
      409,
    );
    await rooms.presence(connection.actor, id, connection.id, true);
    connection.roomId = id;
    if (connection.socket.readyState !== WebSocket.OPEN || connection.cleaned) {
      await rooms.presence(connection.actor, id, connection.id, false);
      return;
    }
    send(connection, {
      type: "snapshot",
      requestId,
      room: await rooms.snapshot(connection.actor, id),
    });
    await broadcast(id);
  }
  async function message(connection: Connection, input: ClientMessage) {
    connection.actor = await requiredAuth().authenticate(connection.token);
    ensure(connection.actor.approved, "APPROVAL_REQUIRED", 403);
    switch (input.type) {
      case "ping":
        send(connection, { type: "pong", requestId: input.requestId });
        break;
      case "create-room": {
        ensure(
          connection.roomId === null ||
            connection.roomId ===
              digest(`create:${connection.actor.uid}:${input.requestId}`),
          "ONE_ROOM_PER_CONNECTION",
          409,
        );
        const room = await rooms.create(connection.actor, input.requestId);
        await subscribe(connection, room.id, input.requestId);
        break;
      }
      case "join-code":
      case "join-link": {
        if (connection.roomId !== null) {
          const current = await rooms.snapshot(
            connection.actor,
            connection.roomId,
          );
          ensure(
            input.type === "join-code"
              ? input.code === current.invitation.code
              : input.roomId === current.id,
            "ONE_ROOM_PER_CONNECTION",
            409,
          );
        }
        const room = await rooms.join(
          connection.actor,
          input.type === "join-code"
            ? { code: input.code }
            : { roomId: input.roomId, token: input.token },
        );
        await subscribe(connection, room.id, input.requestId);
        break;
      }
      case "subscribe-room":
        await subscribe(connection, input.roomId, input.requestId);
        break;
      case "room-command": {
        ensure(connection.roomId === input.roomId, "SUBSCRIBE_FIRST", 403);
        const result = await rooms.command(
          connection.actor,
          input.roomId,
          input.commandId,
          input.expectedRevision,
          input.action,
        );
        send(connection, {
          type: "ack",
          requestId: input.requestId,
          commandId: input.commandId,
          revision: result.revision,
          duplicate: result.duplicate,
        });
        await broadcast(input.roomId, result.closed);
        break;
      }
    }
  }
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      origin(request);
      ensure(request.url === "/ws", "NOT_FOUND", 404);
      rates.take(`upgrade:${request.socket.remoteAddress}`, 30);
      ensure(connections.size < 128, "SERVER_FULL", 503);
      const sessionToken = token(request);
      const actor = await requiredAuth().authenticate(sessionToken);
      ensure(actor.approved, "APPROVAL_REQUIRED", 403);
      if (socket.destroyed) return;
      ensure(!shuttingDown, "SERVICE_UNAVAILABLE", 503);
      ensure(connections.size < 128, "SERVER_FULL", 503);
      sockets.handleUpgrade(request, socket, head, (ws) => {
        const connection: Connection = {
          socket: ws,
          id: randomUUID(),
          token: sessionToken,
          actor,
          roomId: null,
          alive: true,
          pending: Promise.resolve(),
          queued: 0,
          cleaned: false,
        };
        connections.add(connection);
        ws.on("pong", () => {
          connection.alive = true;
        });
        ws.on("close", () => {
          void cleanup(connection);
        });
        ws.on("error", () => {
          ws.terminate();
          void cleanup(connection);
        });
        ws.on("message", (data, binary) => {
          if (connection.queued >= 8) {
            ws.close(1008, "Too many pending messages");
            return;
          }
          let input: ClientMessage;
          try {
            rates.take(`ws:${connection.id}`, 120);
            input = clientMessageSchema.parse(
              binary ? null : JSON.parse(data.toString()),
            );
          } catch (error) {
            if (error instanceof ServiceError && error.status === 429)
              ws.close(1008, "Rate limited");
            else
              send(connection, {
                type: "error",
                requestId: null,
                code: "INVALID_MESSAGE",
              });
            return;
          }
          connection.queued++;
          connection.pending = connection.pending
            .then(async () => {
              try {
                await message(connection, input);
              } catch (error) {
                const code =
                  error instanceof ServiceError
                    ? error.code
                    : "SERVICE_UNAVAILABLE";
                if (!(error instanceof ServiceError))
                  log({ event: "command_failure", code });
                send(connection, {
                  type: "error",
                  requestId: input.requestId,
                  code,
                });
                if (error instanceof ServiceError && error.status === 401)
                  ws.close(1008, "Sign in again");
              }
            })
            .catch(() => {
              log({ event: "connection_failure", code: "SERVICE_UNAVAILABLE" });
              ws.terminate();
            })
            .finally(() => {
              connection.queued--;
            });
        });
      });
    })().catch((error) => {
      const status = error instanceof ServiceError ? error.status : 503;
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
  });
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive || connection.actor.expiresAt <= now()) {
        connection.socket.terminate();
        void cleanup(connection);
      } else {
        connection.alive = false;
        connection.socket.ping();
      }
    }
  }, 15_000).unref();
  let maintenanceTask: Promise<unknown> | null = null;
  let shuttingDown = false;
  const maintenance = setInterval(() => {
    if (maintenanceTask) return;
    maintenanceTask = Promise.all([
      rooms
        .checkpoint()
        .then((ids) => Promise.all(ids.map((id) => broadcast(id)))),
      auth?.cleanup(),
    ])
      .catch(() =>
        log({ event: "maintenance_failure", code: "SERVICE_UNAVAILABLE" }),
      )
      .finally(() => {
        maintenanceTask = null;
      });
  }, 60_000).unref();
  return {
    server,
    rooms,
    auth,
    async close() {
      shuttingDown = true;
      clearInterval(heartbeat);
      clearInterval(maintenance);
      await maintenanceTask;
      await Promise.all(
        [...connections].map(async (connection) => {
          connection.socket.terminate();
          await cleanup(connection);
        }),
      );
      sockets.close();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
