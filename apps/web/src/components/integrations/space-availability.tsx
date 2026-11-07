import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AvailabilityKind, SpaceAvailability } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { mcpIdentifierConflictText } from "../../lib/mcp-identifier-conflict";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** The user's spaces; choosing where something is available only matters with two or more. */
export function useOwnSpaces(): Array<{ id: string; name: string }> {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const spaces = useQuery(queries.spaces.list.queryOptions());
  return (
    spaces.data?.spaces.map((space) => ({
      ...space,
      name: space.isDefault && space.name === "Personal" ? t`Default business scope` : space.name,
    })) ?? []
  );
}

/** True when removing an item takes it from more than this one space. */
export function reachesOtherSpaces(
  availability: SpaceAvailability | undefined,
  spaceCount: number,
): boolean {
  return (
    spaceCount > 1 && Boolean(availability?.allSpaces || (availability?.spaceIds.length ?? 0) > 1)
  );
}

/** A muted note for list rows on items that are not available everywhere. */
export function AvailabilityLabel({ availability }: { availability?: SpaceAvailability }) {
  const spaces = useOwnSpaces();
  if (spaces.length < 2 || !availability || availability.allSpaces) return null;
  const only =
    availability.spaceIds.length === 1
      ? spaces.find((s) => s.id === availability.spaceIds[0])
      : null;
  return (
    <span className="shrink-0 text-[12.5px] text-muted-foreground">
      {only ? (
        only.name
      ) : (
        <Plural
          value={availability.spaceIds.length}
          one="# business scope"
          other="# business scopes"
        />
      )}
    </span>
  );
}

/** "Available in" for one of the user's items, shown only to someone with several spaces. */
export function AvailabilityControl({
  kind,
  id,
  availability,
  onChanged,
}: {
  kind: AvailabilityKind;
  id: string;
  availability?: SpaceAvailability;
  onChanged: () => Promise<unknown> | unknown;
}) {
  const { t } = useLingui();
  const spaces = useOwnSpaces();
  const [saving, setSaving] = useState(false);
  // The failure is kept, not its words, so its message follows the interface language.
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  if (spaces.length < 2 || !availability) return null;
  const error = failure
    ? ((kind === "mcpServer" ? mcpIdentifierConflictText(failure.cause) : null) ??
      errorText(failure.cause, t`Could not change where this is available`))
    : null;

  async function save(next: SpaceAvailability) {
    setSaving(true);
    setFailure(null);
    try {
      await rpc.availability.set({ kind, id, ...next });
      await onChanged();
    } catch (err) {
      setFailure({ cause: err });
    } finally {
      setSaving(false);
    }
  }

  const chosen = availability.allSpaces ? spaces.map((space) => space.id) : availability.spaceIds;
  const summary = availability.allSpaces ? (
    <Trans>All business scopes</Trans>
  ) : chosen.length === 1 ? (
    (spaces.find((space) => space.id === chosen[0])?.name ?? <Trans>1 business scope</Trans>)
  ) : (
    <Plural value={chosen.length} one="# business scope" other="# business scopes" />
  );
  const toggle = (spaceId: string) => {
    const next = chosen.includes(spaceId)
      ? chosen.filter((other) => other !== spaceId)
      : [...chosen, spaceId];
    // At least one space keeps it; none would be removing it, which has its own action.
    if (!next.length) return;
    void save({ allSpaces: false, spaceIds: next });
  };

  return (
    <div data-testid="availability" className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-muted-foreground">
        <Trans>Available in</Trans>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              className="h-6 gap-1 px-1.5 text-xs font-normal text-foreground"
            />
          }
        >
          {summary}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuCheckboxItem
            checked={availability.allSpaces}
            onCheckedChange={(checked) =>
              void save(
                checked
                  ? { allSpaces: true, spaceIds: availability.spaceIds }
                  : { allSpaces: false, spaceIds: availability.spaceIds },
              )
            }
          >
            <Trans>All business scopes</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {spaces.map((space) => (
            <DropdownMenuCheckboxItem
              key={space.id}
              checked={chosen.includes(space.id)}
              onCheckedChange={() => toggle(space.id)}
            >
              {space.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <span role="alert" className="text-[13px] text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
