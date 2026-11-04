import { oc } from "@orpc/contract";
import * as z from "zod";
import { TradingScopeSchema } from "./trading.js";

const id = z.string().min(1).max(128);
export const TradingWorkspaceScopeSchema = TradingScopeSchema.omit({ stage: true }).extend({
  environment: z.literal("simulation"),
});
export const TradingWorkspaceSchema = z.strictObject({
  id,
  name: z.string(),
  spaceId: id,
  ownerUserId: id,
  algorithmApproverUserId: id,
  tradeApproverUserId: id,
  scope: TradingWorkspaceScopeSchema,
  deskIds: z.array(id),
  botIds: z.array(id),
  createdAt: z.string(),
});
const purpose = z.enum([
  "market_data",
  "forecasts",
  "weather_forecast",
  "positions",
  "rules",
  "execution",
  "receipts",
  "other",
]);
const endpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  }, "Use an HTTP(S) URL without embedded credentials");
const http = z
  .strictObject({
    transport: z.literal("http"),
    url: endpoint,
    method: z.enum(["GET", "POST"]).default("GET"),
    query: z.record(z.string().min(1).max(128), z.string().max(2000)).default({}),
    body: z.string().max(32000).default(""),
    auth: z.enum(["none", "bearer", "header", "query"]).default("none"),
    authName: z.string().max(128).default(""),
  })
  .superRefine((value, ctx) => {
    if (
      (value.auth === "header" || value.auth === "query") &&
      !/^[A-Za-z0-9_-]+$/.test(value.authName)
    )
      ctx.addIssue({
        code: "custom",
        path: ["authName"],
        message: "Name the authentication header or query parameter",
      });
    if (value.method === "GET" && value.body)
      ctx.addIssue({ code: "custom", path: ["body"], message: "GET requests cannot have a body" });
  });
export const TradingInterfaceConfigSchema = z.discriminatedUnion("transport", [
  http,
  z.strictObject({ transport: z.literal("push") }),
  z.strictObject({ transport: z.literal("mcp"), serverId: id }),
]);
export const TradingInterfaceSchema = z.strictObject({
  id,
  workspaceId: id,
  name: z.string(),
  purpose,
  config: TradingInterfaceConfigSchema,
  hasSecret: z.boolean(),
  hasPushToken: z.boolean().default(false),
  revision: z.number().int().positive(),
  updatedAt: z.string(),
  // Saving metadata is not a live connectivity test or permission to execute.
  status: z.literal("configured"),
});
const createScopeInput = z.strictObject({
  id: id.optional(),
  name: z.string().trim().min(1).max(60),
  scope: TradingWorkspaceScopeSchema,
  algorithmApproverUserId: id,
  tradeApproverUserId: id,
});
export const tradingWorkspaceContract = {
  workspaces: oc.input(z.strictObject({})).output(z.array(TradingWorkspaceSchema)),
  // Configure the current business Space, or create a new isolated business Space.
  createWorkspace: oc.input(createScopeInput).output(TradingWorkspaceSchema),
  createBusinessScope: oc.input(createScopeInput).output(TradingWorkspaceSchema),
  connectWorkspaceBot: oc
    .input(z.strictObject({ workspaceId: id, botId: id }))
    .output(z.strictObject({ deskIds: z.array(id) })),
  interfaces: oc.input(z.strictObject({ workspaceId: id })).output(z.array(TradingInterfaceSchema)),
  saveInterface: oc
    .input(
      z.strictObject({
        id,
        workspaceId: id,
        name: z.string().trim().min(1).max(100),
        purpose,
        config: TradingInterfaceConfigSchema,
        secret: z.string().max(16384).optional(),
        expectedRevision: z.number().int().min(0),
      }),
    )
    .output(TradingInterfaceSchema),
  removeInterface: oc
    .input(z.strictObject({ workspaceId: id, id, expectedRevision: z.number().int().positive() }))
    .output(z.strictObject({ removed: z.boolean() })),
};
export type TradingWorkspace = z.infer<typeof TradingWorkspaceSchema>;
export type TradingInterface = z.infer<typeof TradingInterfaceSchema>;
