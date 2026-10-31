import { expect, it } from "vitest";
import { clientMessageSchema, serverMessageSchema } from "./index";
it("accepts versioned ping/pong and rejects unknown fields and versions", () => {
  expect(
    clientMessageSchema.safeParse({ version: 2, type: "ping", requestId: "a" })
      .success,
  ).toBe(true);
  expect(
    serverMessageSchema.safeParse({ version: 2, type: "pong", requestId: "a" })
      .success,
  ).toBe(true);
  for (const input of [
    null,
    { version: 99, type: "ping", requestId: "a" },
    { version: 2, type: "ping", requestId: "" },
    { version: 2, type: "ping", requestId: "a", state: {} },
  ]) {
    expect(clientMessageSchema.safeParse(input).success).toBe(false);
  }
});
it("rejects identity injection, invalid tile values and extra authoritative state in commands", () => {
  const valid = {
    version: 2,
    requestId: "r",
    type: "room-command",
    roomId: "room",
    commandId: "cmd",
    expectedRevision: 0,
    action: { type: "draw", expectedRoundRevision: 0 },
  };
  expect(clientMessageSchema.safeParse(valid).success).toBe(true);
  expect(
    clientMessageSchema.safeParse({ ...valid, playerId: "another-user" })
      .success,
  ).toBe(false);
  expect(clientMessageSchema.safeParse({ ...valid, state: {} }).success).toBe(
    false,
  );
  expect(
    clientMessageSchema.safeParse({ ...valid, expectedRevision: -1 }).success,
  ).toBe(false);
  expect(
    clientMessageSchema.safeParse({
      ...valid,
      action: {
        type: "play",
        expectedRoundRevision: 0,
        steps: [
          {
            type: "open",
            melds: [
              {
                id: "m",
                kind: "run",
                tiles: [0, 1, 2].map((value) => ({
                  tileId: String(value),
                  color: "red",
                  value,
                })),
              },
            ],
          },
        ],
      },
    }).success,
  ).toBe(false);
});
