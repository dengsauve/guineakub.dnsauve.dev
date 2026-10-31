import { z } from "zod";
export const PROTOCOL_VERSION = 2 as const;
import { idSchema, revisionSchema, roomActionSchema } from "./game";
export * from "./game";
const envelope = { version: z.literal(PROTOCOL_VERSION), requestId: idSchema };
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("ping") }),
  z.strictObject({ ...envelope, type: z.literal("create-room") }),
  z.strictObject({
    ...envelope,
    type: z.literal("join-code"),
    code: z.string().regex(/^[A-Z2-9]{8}$/),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("join-link"),
    roomId: idSchema,
    token: z.string().min(32).max(128),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("subscribe-room"),
    roomId: idSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("room-command"),
    roomId: idSchema,
    commandId: idSchema,
    expectedRevision: revisionSchema,
    action: roomActionSchema,
  }),
]);
import { roomViewSchema } from "./views";
export * from "./views";
const serverEnvelope = {
  version: z.literal(PROTOCOL_VERSION),
  requestId: idSchema.nullable(),
};
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...serverEnvelope, type: z.literal("pong") }),
  z.strictObject({
    ...serverEnvelope,
    type: z.literal("error"),
    code: z
      .string()
      .regex(/^[A-Z_]+$/)
      .max(80),
  }),
  z.strictObject({
    ...serverEnvelope,
    type: z.literal("snapshot"),
    room: roomViewSchema,
  }),
  z.strictObject({
    ...serverEnvelope,
    type: z.literal("ack"),
    commandId: idSchema,
    revision: revisionSchema,
    duplicate: z.boolean(),
  }),
  z.strictObject({ ...serverEnvelope, type: z.literal("room-closed") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
