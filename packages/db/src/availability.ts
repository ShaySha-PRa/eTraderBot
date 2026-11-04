/**
 * Skills, MCP servers and plugin or tool-source installs belong to the account that added them.
 * Each is available in the space it was added in (`spaceId`), in every space of its owner
 * (`allSpaces`, which includes spaces created later), or also in chosen further spaces
 * (`availableIn`). Nobody but the owner ever sees them.
 */
export function availableInSpace(scope: { spaceId: string; userId: string }) {
  return {
    userId: scope.userId,
    OR: [
      { spaceId: scope.spaceId },
      {
        // Global availability is only for general workspaces. Trading resources never
        // become writable dependencies of a general Bot, or visible across businesses.
        space: {
          kind: "general",
          organization: { spaces: { some: { id: scope.spaceId, kind: "general" } } },
        },
        OR: [{ allSpaces: true }, { availableIn: { some: { spaceId: scope.spaceId } } }],
      },
    ],
  };
}

/** An item's secret is this space's or, once the item reaches further spaces, the account's. */
export function itemSecretIn(scope: { spaceId: string; userId: string }) {
  return { userId: scope.userId, OR: [{ spaceId: scope.spaceId }, { spaceId: null }] };
}

/** Select alongside a row so `spaceAvailability` can describe it. */
export const AVAILABILITY_SELECT = { select: { spaceId: true } } as const;

export type SpaceAvailability = { allSpaces: boolean; spaceIds: string[] };

/** The spaces an item is available in, starting with the one it was added in. */
export function spaceAvailability(row: {
  spaceId: string;
  allSpaces: boolean;
  availableIn?: Array<{ spaceId: string }>;
}): SpaceAvailability {
  return {
    allSpaces: row.allSpaces,
    spaceIds: [
      row.spaceId,
      ...(row.availableIn ?? []).map((entry) => entry.spaceId).filter((id) => id !== row.spaceId),
    ],
  };
}

/** Host stdio processes have no workspace filesystem boundary; general Bots cannot use them. */
export function mcpAvailableToBot(scope: { spaceId: string; userId: string }) {
  return {
    enabled: true,
    ...availableInSpace(scope),
    AND: [{ OR: [{ transport: { not: "stdio" } }, { space: { kind: "trading" } }] }],
  };
}
