import type { Prisma, PrismaClient } from "./client.js";

/** Call within the delivery transaction to serialize against disabling either bot. */
export async function crossSpaceCommunicationAllowed(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">,
  senderBotId: string,
  targetBotId: string,
): Promise<boolean> {
  const bots = await prisma.$queryRaw<
    Array<{
      id: string;
      spaceId: string;
      crossSpaceCommunication: boolean;
      archivedAt: Date | null;
      workspaceKind: string;
    }>
  >`
    SELECT b.id, b."spaceId", b."crossSpaceCommunication", b."archivedAt", s.kind AS "workspaceKind" FROM bots b JOIN spaces s ON s.id=b."spaceId"
    WHERE b.id = ${senderBotId} OR b.id = ${targetBotId}
    ORDER BY b.id FOR NO KEY UPDATE OF b
  `;
  if (bots.length !== 2 || bots.some((bot) => bot.archivedAt)) return false;
  return (
    bots[0]!.spaceId === bots[1]!.spaceId ||
    bots.every((bot) => bot.workspaceKind === "general" && bot.crossSpaceCommunication === true)
  );
}

export class CrossSpaceCommunicationBlockedError extends Error {
  constructor() {
    super("Cross-space bot communication is disabled.");
    this.name = "CrossSpaceCommunicationBlockedError";
  }
}
