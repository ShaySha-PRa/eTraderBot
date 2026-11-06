import { oc } from "@orpc/contract";
import { z } from "zod";

const Id = z.string().min(1).max(200);
const Text = z.string().min(1).max(100_000);
const Version = z.number().int().positive();
const Selection = z.strictObject({ id: Id, revision: z.string().min(1).max(100) });
export const HandoffApplicabilitySchema = z.strictObject({
  conditions: z.array(z.string().min(1).max(2000)).min(1).max(20),
  limitations: z.array(z.string().min(1).max(2000)).max(20),
});
export const HandoffItemSchema = z.strictObject({
  key: Id,
  kind: z.enum(["summary", "memory", "skill"]),
  title: z.string().min(1).max(500),
  content: Text,
  description: z.string().max(2000).nullable(),
  files: z.record(z.string(), z.string()).nullable(),
  sourceId: Id.nullable(),
  sourceRevision: z.string(),
  contentHash: z.string(),
});
export const HandoffSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(200),
  sourceBotName: z.string(),
  sourceSpaceName: z.string(),
  sourceWorkspaceKind: z.enum(["general", "trading"]),
  applicability: HandoffApplicabilitySchema,
  items: z.array(HandoffItemSchema).min(1).max(50),
});
export const HandoffPackageSchema = z.object({
  id: Id,
  sourceBotId: Id,
  sourceSpaceId: Id,
  lineageId: Id,
  version: Version,
  previousPackageId: Id.nullable(),
  contentHash: z.string(),
  snapshot: HandoffSnapshotSchema,
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export const CreateHandoffInputSchema = z.strictObject({
  requestId: Id,
  sourceBotId: Id,
  previousPackageId: Id.optional(),
  title: z.string().trim().min(1).max(200),
  applicability: HandoffApplicabilitySchema,
  summaries: z.array(z.strictObject({ title: z.string().min(1).max(200), content: Text })).max(50),
  memories: z.array(Selection).max(50),
  skills: z.array(Selection).max(50),
});
// No overwrite action. Every item must appear exactly once; skip is explicit.
export const HandoffPlanSchema = z
  .array(
    z.strictObject({
      itemKey: Id,
      action: z.enum(["copy", "skip"]),
      targetName: z.string().min(1).max(200),
    }),
  )
  .min(1)
  .max(50);
export const PreviewHandoffInputSchema = z.strictObject({
  packageId: Id,
  targetBotId: Id,
  plan: HandoffPlanSchema.optional(),
});
export const ConfirmHandoffInputSchema = PreviewHandoffInputSchema.extend({
  plan: HandoffPlanSchema,
  previewHash: z.string().min(1),
});
export const HandoffReceiptSchema = z.object({
  id: Id,
  packageId: Id,
  packageVersion: Version,
  packageHash: z.string(),
  sourceSpaceId: Id,
  sourceBotId: Id,
  sourceBotName: z.string(),
  targetSpaceId: Id,
  targetBotId: Id,
  targetBotName: z.string(),
  createdAt: z.string(),
  items: z.array(
    z.object({
      itemKey: Id,
      kind: z.enum(["summary", "memory", "skill"]),
      targetName: z.string(),
      targetId: Id.nullable(),
      initialRevision: Version.nullable(),
      status: z.enum(["copied", "pending", "skipped"]),
    }),
  ),
});
export const HandoffPreviewSchema = z.object({
  package: HandoffPackageSchema,
  plan: HandoffPlanSchema,
  previewHash: z.string(),
  conflicts: z.array(z.object({ itemKey: Id, reason: z.string() })),
  alreadyImported: HandoffReceiptSchema.nullable(),
});
export const HandoffSkillSchema = z.object({
  id: Id,
  botId: Id,
  importId: Id,
  itemKey: Id,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  files: z.record(z.string(), z.string()),
  revision: Version,
  enabledAt: z.string().nullable(),
  blockedReason: z.literal("name_conflict").nullable(),
});
const Page = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: Id.optional(),
});
/** Live catalog metadata only; never added to immutable package snapshots. */
export const HandoffCatalogSourceTypeSchema = z.enum([
  "bot_memory",
  "shared_memory",
  "workspace_skill",
  "imported_skill",
]);
export const HandoffCatalogEntrySchema = z.object({
  id: Id,
  kind: z.enum(["memory", "skill"]),
  sourceType: HandoffCatalogSourceTypeSchema,
  title: z.string(),
  revision: z.string(),
});
export const experienceHandoffContract = {
  catalog: oc.input(z.strictObject({ sourceBotId: Id })).output(z.array(HandoffCatalogEntrySchema)),
  create: oc.input(CreateHandoffInputSchema).output(HandoffPackageSchema),
  get: oc.input(z.strictObject({ packageId: Id })).output(HandoffPackageSchema),
  packages: oc
    .input(Page)
    .output(z.object({ items: z.array(HandoffPackageSchema), nextCursor: Id.nullable() })),
  preview: oc.input(PreviewHandoffInputSchema).output(HandoffPreviewSchema),
  confirm: oc.input(ConfirmHandoffInputSchema).output(HandoffReceiptSchema),
  history: oc
    .input(Page.extend({ botId: Id.optional() }))
    .output(z.object({ items: z.array(HandoffReceiptSchema), nextCursor: Id.nullable() })),
  importDetail: oc
    .input(z.strictObject({ importId: Id }))
    .output(z.object({ receipt: HandoffReceiptSchema, package: HandoffPackageSchema })),
  revoke: oc.input(z.strictObject({ packageId: Id })).output(HandoffPackageSchema),
  skills: oc.input(z.strictObject({ botId: Id })).output(z.array(HandoffSkillSchema)),
  updateSkill: oc
    .input(
      z.strictObject({
        skillId: Id,
        expectedRevision: Version,
        content: Text.optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .output(HandoffSkillSchema),
};
export type HandoffItem = z.infer<typeof HandoffItemSchema>;
export type HandoffSnapshot = z.infer<typeof HandoffSnapshotSchema>;
export type HandoffPackage = z.infer<typeof HandoffPackageSchema>;
export type HandoffPlan = z.infer<typeof HandoffPlanSchema>;
export type HandoffReceipt = z.infer<typeof HandoffReceiptSchema>;
export type HandoffCatalogSourceType = z.infer<typeof HandoffCatalogSourceTypeSchema>;
export type HandoffCatalogEntry = z.infer<typeof HandoffCatalogEntrySchema>;
