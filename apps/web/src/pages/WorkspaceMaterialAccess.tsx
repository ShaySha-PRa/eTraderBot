import { Trans, useLingui } from "@lingui/react/macro";
import { Button, NativeSelect, NativeSelectOption, SectionHeading } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useTradingActions } from "../lib/trading-actions";

export function WorkspaceMaterialAccess() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const cache = useQueryClient();
  const navigation = useQuery(queries.spaces.list.queryOptions({ input: {} }));
  const catalog = useQuery(queries.workspaceAccess.catalog.queryOptions({ input: {} }));
  const grants = useQuery(queries.workspaceAccess.grants.queryOptions({ input: {} }));
  const audit = useQuery(queries.workspaceAccess.audit.queryOptions({ input: {} }));
  const { api, act, pending, error, identityDialog } = useTradingActions();
  const [recipient, setRecipient] = useState("");
  const [selected, setSelected] = useState("");
  const id = useId();
  const recipients =
    navigation.data?.spaces
      .filter((space) => space.kind === "general" && !space.isolationPending)
      .flatMap((space) =>
        space.bots.map((bot) => ({ id: bot.id, name: `${space.name} · ${bot.name}` })),
      ) ?? [];
  const materials = catalog.data ?? [];
  const material = materials.find((row) => `${row.kind}:${row.resourceId}` === selected);
  async function change(action: () => Promise<unknown>) {
    await act(async () => {
      await action();
      await cache.invalidateQueries({ queryKey: queries.workspaceAccess.key() });
    }, true);
  }
  return (
    <section className="grid gap-3 rounded-xl border p-4" data-testid="workspace-material-access">
      <SectionHeading>
        <Trans>Read-only material access</Trans>
      </SectionHeading>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Share selected records with a general Bot. Revoking access stops future reads; it cannot
          recall content already read.
        </Trans>
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (material && recipient)
            void change(() =>
              api.workspaceAccess.grant({
                id: crypto.randomUUID(),
                recipientBotId: recipient,
                kind: material.kind,
                resourceId: material.resourceId,
              }),
            );
        }}
      >
        <div className="grid gap-1">
          <label htmlFor={`${id}-recipient`}>
            <Trans>Recipient Bot</Trans>
          </label>
          <NativeSelect
            id={`${id}-recipient`}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          >
            <NativeSelectOption value="">{t`Select a Bot`}</NativeSelectOption>
            {recipients.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-material`}>
            <Trans>Material</Trans>
          </label>
          <NativeSelect
            id={`${id}-material`}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <NativeSelectOption value="">{t`Select material`}</NativeSelectOption>
            {materials.map((row) => (
              <NativeSelectOption
                key={`${row.kind}:${row.resourceId}`}
                value={`${row.kind}:${row.resourceId}`}
              >
                {
                  {
                    memory: t`Memory`,
                    skill: t`Skill`,
                    weather: t`Weather forecasts`,
                    analysis: t`Analysis`,
                  }[row.kind]
                }{" "}
                · {row.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={pending || !recipient || !material}>
          <Trans>Grant read access</Trans>
        </Button>
      </form>
      {error || catalog.error || grants.error ? (
        <p role="alert" className="text-destructive">
          {error || t`Could not load material access`}
        </p>
      ) : null}
      {(grants.data ?? []).map((grant) => (
        <div key={grant.id} className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
          <span className="min-w-0 flex-1 break-all">
            {recipients.find((bot) => bot.id === grant.recipientBotId)?.name ??
              grant.recipientBotId}{" "}
            ·{" "}
            {materials.find((row) => row.resourceId === grant.resourceId && row.kind === grant.kind)
              ?.title ?? grant.resourceId}
          </span>
          {grant.revokedAt ? (
            <span>
              <Trans>Revoked</Trans>
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void change(() => api.workspaceAccess.revoke({ id: grant.id }))}
            >
              <Trans>Revoke</Trans>
            </Button>
          )}
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-sm">
          <Trans>Access audit</Trans>
        </summary>
        <ul className="grid gap-1 text-xs text-muted-foreground">
          {audit.data?.map((entry) => (
            <li key={entry.id}>
              {new Date(entry.createdAt).toLocaleString()} ·{" "}
              {
                {
                  granted: t`Granted`,
                  revoked: t`Revoked`,
                  read: t`Read`,
                  read_denied: t`Read denied`,
                }[entry.action]
              }{" "}
              · {entry.grantId}
            </li>
          ))}
        </ul>
      </details>
      {identityDialog}
    </section>
  );
}
