import { oc } from "@orpc/contract";
import { z } from "zod";
import { TicketSchema } from "./board.js";

export const BusinessOverviewSchema = z.object({
  spaceId: z.string(),
  supervisorId: z.string(),
  counts: z.object({
    todo: z.number(),
    doing: z.number(),
    review: z.number(),
    blocked: z.number(),
    done: z.number(),
    closed: z.number(),
  }),
  total: z.number(),
  completed: z.number(),
  completionPercent: z.number(),
  team: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      activeRuns: z.number(),
      failedRuns: z.number(),
    }),
  ),
  recentTasks: z.array(TicketSchema.extend({ latestComment: z.string().nullable() })),
});
export const businessSupervisorContract = {
  overview: oc.input(z.strictObject({})).output(BusinessOverviewSchema),
};
