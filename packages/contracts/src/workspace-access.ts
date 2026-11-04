import { oc } from "@orpc/contract";
import * as z from "zod";

const id = z.string().min(1).max(128);
export const WorkspaceMaterialKindSchema = z.enum(["analysis", "weather", "memory", "skill"]);
export const WorkspaceReadGrantSchema = z.strictObject({
  id,
  sourceSpaceId: id,
  recipientSpaceId: id,
  recipientBotId: id,
  createdByUserId: id,
  kind: WorkspaceMaterialKindSchema,
  resourceId: id,
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export const WorkspaceMaterialSchema = z.strictObject({
  kind: WorkspaceMaterialKindSchema,
  resourceId: id,
  title: z.string(),
  revision: z.string(),
  content: z.json(),
});
export const workspaceAccessContract = {
  catalog: oc
    .input(z.strictObject({}))
    .output(z.array(WorkspaceMaterialSchema.omit({ content: true }))),
  grants: oc.input(z.strictObject({})).output(z.array(WorkspaceReadGrantSchema)),
  grant: oc
    .input(
      z.strictObject({ id, recipientBotId: id, kind: WorkspaceMaterialKindSchema, resourceId: id }),
    )
    .output(WorkspaceReadGrantSchema),
  revoke: oc.input(z.strictObject({ id })).output(WorkspaceReadGrantSchema),
  received: oc.input(z.strictObject({ botId: id })).output(z.array(WorkspaceReadGrantSchema)),
  read: oc
    .input(z.strictObject({ botId: id, grantId: id }))
    .output(z.strictObject({ grant: WorkspaceReadGrantSchema, material: WorkspaceMaterialSchema })),
  audit: oc.input(z.strictObject({})).output(
    z.array(
      z.strictObject({
        id,
        grantId: id,
        sourceSpaceId: id,
        actorUserId: id,
        actorBotId: id.nullable(),
        action: z.enum(["granted", "revoked", "read", "read_denied"]),
        createdAt: z.string(),
      }),
    ),
  ),
};
export const WorkspaceReadCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({ operation: z.literal("read"), grantId: id }),
]);
export type WorkspaceReadGrant = z.infer<typeof WorkspaceReadGrantSchema>;
export type WorkspaceMaterial = z.infer<typeof WorkspaceMaterialSchema>;

export function workspaceReadJsonSchema() {
  return z.toJSONSchema(WorkspaceReadCommandSchema);
}

/** Offline migration plan; never exposed as a Bot or public RPC operation. */
export const WorkspaceMigrationChoiceSchema = z.strictObject({
  sourceSpaceId: id,
  userId: id,
  botIds: z.array(id).min(1),
  targetSpaceId: id,
  targetName: z.string().trim().min(1).max(60),
});
export type WorkspaceMigrationChoice = z.infer<typeof WorkspaceMigrationChoiceSchema>;
