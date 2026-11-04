import { useLingui } from "@lingui/react/macro";
import type { Space } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";

type ScopeLabel = Pick<Space, "id" | "name">;

/** Labels reflect visible memberships; missing/loading data never invents an affiliation. */
export function BotBusinessLabels({
  scopes,
  compact = false,
}: {
  scopes?: readonly ScopeLabel[];
  compact?: boolean;
}) {
  const { t } = useLingui();
  if (!scopes?.length) return null;
  const names = scopes.map((scope) => scope.name).join(" · ");
  return (
    <span
      data-testid="bot-business-labels"
      className={`flex min-w-0 gap-1 ${compact ? "max-w-36" : "mt-1 flex-wrap"}`}
    >
      {compact ? (
        <Badge
          variant="outline"
          className="min-w-0 max-w-full text-muted-foreground"
          title={`${t`Business scope`}: ${names}`}
        >
          <span className="truncate" dir="auto">
            {names}
          </span>
        </Badge>
      ) : (
        scopes.map((scope) => (
          <Badge
            key={scope.id}
            variant="outline"
            className="max-w-full text-muted-foreground"
            title={`${t`Business scope`}: ${scope.name}`}
          >
            <span className="truncate" dir="auto">
              {scope.name}
            </span>
          </Badge>
        ))
      )}
    </span>
  );
}
