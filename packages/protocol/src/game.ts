import { z } from "zod";
export const idSchema = z.string().min(1).max(128);
export const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const placementSchema = z.strictObject({
  tileId: idSchema,
  color: z.enum(["red", "blue", "black", "orange"]),
  value: z.number().int().min(1).max(13),
});
export const meldSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["group", "run"]),
  tiles: z.array(placementSchema).min(3).max(13),
});
const melds = z.array(meldSchema).max(72);
export const turnStepSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("open"), melds }),
  z.strictObject({ type: z.literal("lay"), melds }),
  z.strictObject({
    type: z.literal("rearrange"),
    sourceIds: z.array(idSchema).min(1).max(72),
    melds,
  }),
  z.strictObject({ type: z.literal("split-run"), sourceId: idSchema, melds }),
  z.strictObject({
    type: z.literal("retrieve-joker"),
    sourceId: idSchema,
    jokerId: idSchema,
    replacementId: idSchema.optional(),
    melds,
  }),
  z.strictObject({
    type: z.literal("detach-numbered"),
    sourceId: idSchema,
    tileId: idSchema,
    replacementId: idSchema.optional(),
    melds,
  }),
]);
export const roomActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("abandon") }),
  z.strictObject({ type: z.literal("end") }),
  z.strictObject({ type: z.literal("reset-scores") }),
  z.strictObject({ type: z.literal("remove-player"), playerId: idSchema }),
  z.strictObject({
    type: z.literal("draw"),
    expectedRoundRevision: revisionSchema,
  }),
  z.strictObject({
    type: z.literal("pass"),
    expectedRoundRevision: revisionSchema,
  }),
  z.strictObject({
    type: z.literal("play"),
    expectedRoundRevision: revisionSchema,
    steps: z.array(turnStepSchema).min(1).max(128),
  }),
]);
export type RoomAction = z.infer<typeof roomActionSchema>;
