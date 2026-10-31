import { z } from "zod";
import { idSchema, meldSchema, revisionSchema } from "./game";
export const tileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("joker"), id: idSchema }),
  z.strictObject({
    kind: z.literal("number"),
    id: idSchema,
    color: z.enum(["red", "blue", "black", "orange"]),
    value: z.number().int().min(1).max(13),
  }),
]);
const points = z.record(z.string(), z.number().int().nonnegative());
export const roomViewSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  originalHost: idSchema,
  actingHost: idSchema.nullable(),
  phase: z.enum(["lobby", "playing"]),
  members: z
    .array(
      z.strictObject({
        uid: idSchema,
        name: z.string().min(1).max(80),
        connected: z.boolean(),
        score: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(8),
  invitation: z.strictObject({
    code: z.string().length(8),
    token: z.string().length(43),
  }),
  round: z
    .strictObject({
      revision: revisionSchema,
      board: z.array(meldSchema).max(72),
      turnPlayerId: idSchema,
      bagCount: z.number().int().nonnegative().max(214),
      rack: z.array(tileSchema).max(214),
      players: z
        .array(
          z.strictObject({
            id: idSchema,
            rackCount: z.number().int().nonnegative().max(214),
            opened: z.boolean(),
          }),
        )
        .min(2)
        .max(8),
      result: z
        .strictObject({
          reason: z.enum(["empty-rack", "blocked"]),
          winners: z.array(idSchema),
          points,
        })
        .nullable(),
    })
    .nullable(),
});
