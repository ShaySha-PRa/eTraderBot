import { Trans, useLingui } from "@lingui/react/macro";
import type { TradingInterface, TradingWorkspace } from "@rakazo/contracts";
import { TradingInterfaceConfigSchema } from "@rakazo/contracts";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Menu, Plus } from "lucide-react";
import { useId, useState } from "react";
import { useQueryUserId, useSpaceQueries } from "../lib/query";
import { useTradingActions } from "../lib/trading-actions";
import { errorText } from "../lib/user-error";

function usePurposes() {
  const { t } = useLingui();
  return {
    market_data: t`Market data`,
    forecasts: t`Forecasts`,
    positions: t`Positions and assets`,
    rules: t`Market rules`,
    execution: t`Trade execution`,
    receipts: t`Receipts`,
    other: t`Other data`,
  };
}
export function BusinessInterfaces({
  workspace,
  onBack,
  onOpenNavigation,
}: {
  workspace: TradingWorkspace;
  onBack: () => void;
  onOpenNavigation: () => void;
}) {
  const { t } = useLingui();
  const purposes = usePurposes();
  const owner = useQueryUserId() === workspace.ownerUserId;
  const queries = useSpaceQueries();
  const entries = useQuery({
    ...queries.trading.interfaces.queryOptions({ input: { workspaceId: workspace.id } }),
    enabled: owner,
  });
  const { api, act, error, pending, identityDialog } = useTradingActions();
  const [editing, setEditing] = useState<TradingInterface | "new" | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="business-interfaces">
      <header className="flex flex-wrap items-center gap-2 border-b p-4">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Open navigation`}
          onClick={onOpenNavigation}
          className="md:hidden"
        >
          <Menu />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t`Back to bots`} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{workspace.name}</p>
          <h1 className="font-medium">
            <Trans>Interface settings</Trans>
          </h1>
        </div>
        {owner ? (
          <Button onClick={() => setEditing("new")}>
            <Plus size={16} />
            <Trans>Add interface</Trans>
          </Button>
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-4xl gap-5 p-4 sm:p-6">
          {!owner ? (
            <p>
              <Trans>Only the business scope owner can configure interfaces.</Trans>
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Connect HTTP data APIs or select MCP connections for this business scope. Saving a
                  configuration does not verify connectivity or authorize trades.
                </Trans>
              </p>
              {error || entries.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error || errorText(entries.error)}
                </p>
              ) : null}
              {editing ? (
                <InterfaceEditor
                  key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`}
                  workspaceId={workspace.id}
                  entry={editing === "new" ? undefined : editing}
                  onClose={() => setEditing(null)}
                />
              ) : null}
              {entries.isPending ? (
                <p role="status">
                  <Trans>Loading…</Trans>
                </p>
              ) : null}
              {!entries.isPending && !entries.isError && !entries.data?.length && !editing ? (
                <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
                  <Trans>No interfaces configured for this business scope.</Trans>
                </div>
              ) : null}
              {entries.data?.map((entry) => (
                <article
                  key={entry.id}
                  className="grid gap-3 rounded-xl border p-4"
                  data-testid="business-interface"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="font-medium">{entry.name}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {purposes[entry.purpose]} ·{" "}
                        {entry.config.transport === "http" ? "HTTP API" : "MCP"} ·{" "}
                        <Trans>Configured · not verified</Trans>
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setEditing(entry)}>
                      <Trans>Edit</Trans>
                    </Button>
                  </div>
                  {entry.config.transport === "http" ? (
                    <p className="break-all text-sm">
                      {entry.config.method} {entry.config.url}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      <Trans>MCP tool approval remains separate for each bot.</Trans>
                    </p>
                  )}
                  {entry.hasSecret ? (
                    <p className="text-xs text-muted-foreground">
                      <Trans>Credential saved securely</Trans>
                    </p>
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      <Trans>Manage interface</Trans>
                    </summary>
                    <Button
                      className="mt-2"
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void act(
                          () =>
                            api.trading.removeInterface({
                              workspaceId: workspace.id,
                              id: entry.id,
                              expectedRevision: entry.revision,
                            }),
                          true,
                        )
                      }
                    >
                      <Trans>Remove interface</Trans>
                    </Button>
                  </details>
                </article>
              ))}
            </>
          )}
        </div>
      </main>
      {identityDialog}
    </div>
  );
}
function InterfaceEditor({
  workspaceId,
  entry,
  onClose,
}: {
  workspaceId: string;
  entry?: TradingInterface;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const purposes = usePurposes();
  const fieldId = useId();
  const [id] = useState(() => entry?.id ?? crypto.randomUUID());
  const [name, setName] = useState(entry?.name ?? "");
  const [purpose, setPurpose] = useState<TradingInterface["purpose"]>(
    entry?.purpose ?? "market_data",
  );
  const [transport, setTransport] = useState(entry?.config.transport ?? "http");
  const previous = entry?.config.transport === "http" ? entry.config : undefined;
  const [url, setUrl] = useState(previous?.url ?? "");
  const [method, setMethod] = useState(previous?.method ?? "GET");
  const [query, setQuery] = useState(JSON.stringify(previous?.query ?? {}, null, 2));
  const [body, setBody] = useState(previous?.body ?? "");
  const [auth, setAuth] = useState(previous?.auth ?? "none");
  const [authName, setAuthName] = useState(previous?.authName ?? "");
  const [secret, setSecret] = useState("");
  const [serverId, setServerId] = useState(
    entry?.config.transport === "mcp" ? entry.config.serverId : "",
  );
  const queries = useSpaceQueries();
  const servers = useQuery({
    ...queries.mcp.servers.list.queryOptions(),
    enabled: transport === "mcp",
  });
  const { api, act, pending, error, identityDialog } = useTradingActions();
  return (
    <>
      <form
        className="grid gap-4 rounded-xl border bg-card p-4"
        aria-label={t`Interface configuration`}
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            let parameters: unknown = {};
            if (transport === "http") {
              try {
                parameters = JSON.parse(query);
              } catch {
                throw new Error(t`Query parameters must be a JSON object`);
              }
            }
            const config = TradingInterfaceConfigSchema.parse(
              transport === "mcp"
                ? { transport, serverId }
                : {
                    transport,
                    url,
                    method,
                    query: parameters,
                    body: method === "GET" ? "" : body,
                    auth,
                    authName,
                  },
            );
            await api.trading.saveInterface({
              workspaceId,
              id,
              name,
              purpose,
              config,
              expectedRevision: entry?.revision ?? 0,
              ...(config.transport === "http" && config.auth !== "none" && secret
                ? { secret }
                : {}),
            });
            setSecret("");
            onClose();
          }, true);
        }}
      >
        <SectionHeading>{entry ? t`Edit interface` : t`Add interface`}</SectionHeading>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={`${fieldId}-field1`}>
              <Trans>Name</Trans>
            </label>
            <Input
              id={`${fieldId}-field1`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
            />
          </div>
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={`${fieldId}-purpose`}>
              <Trans>Purpose</Trans>
            </label>
            <NativeSelect
              id={`${fieldId}-purpose`}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value as TradingInterface["purpose"])}
            >
              {Object.entries(purposes).map(([key, label]) => (
                <NativeSelectOption key={key} value={key}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={`${fieldId}-field3`}>
              <Trans>Connection type</Trans>
            </label>
            <NativeSelect
              id={`${fieldId}-field3`}
              value={transport}
              onChange={(event) => setTransport(event.target.value as "http" | "mcp")}
            >
              <NativeSelectOption value="http">HTTP API</NativeSelectOption>
              <NativeSelectOption value="mcp">MCP</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>
        {transport === "http" ? (
          <>
            <div className="grid gap-1.5 text-sm">
              <label htmlFor={`${fieldId}-field4`}>
                <Trans>API URL</Trans>
              </label>
              <Input
                id={`${fieldId}-field4`}
                type="url"
                value={url}
                placeholder="https://api.example.test/market/prices"
                onChange={(event) => setUrl(event.target.value)}
                required
                maxLength={2048}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5 text-sm">
                <label htmlFor={`${fieldId}-field5`}>
                  <Trans>Request method</Trans>
                </label>
                <NativeSelect
                  id={`${fieldId}-field5`}
                  value={method}
                  onChange={(event) => setMethod(event.target.value as "GET" | "POST")}
                >
                  <NativeSelectOption value="GET">GET</NativeSelectOption>
                  <NativeSelectOption value="POST">POST</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="grid gap-1.5 text-sm">
                <label htmlFor={`${fieldId}-field6`}>
                  <Trans>Authentication</Trans>
                </label>
                <NativeSelect
                  id={`${fieldId}-field6`}
                  value={auth}
                  onChange={(event) => setAuth(event.target.value as typeof auth)}
                >
                  <NativeSelectOption value="none">{t`None`}</NativeSelectOption>
                  <NativeSelectOption value="bearer">Bearer token</NativeSelectOption>
                  <NativeSelectOption value="header">{t`API key in header`}</NativeSelectOption>
                  <NativeSelectOption value="query">{t`API key in query`}</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
            {auth === "header" || auth === "query" ? (
              <div className="grid gap-1.5 text-sm">
                <label htmlFor={`${fieldId}-field7`}>
                  <Trans>Credential field name</Trans>
                </label>
                <Input
                  id={`${fieldId}-field7`}
                  value={authName}
                  onChange={(event) => setAuthName(event.target.value)}
                  placeholder={auth === "header" ? "X-API-Key" : "api_key"}
                  required
                  maxLength={128}
                />
              </div>
            ) : null}
            {auth !== "none" ? (
              <div className="grid gap-1.5 text-sm">
                <label htmlFor={`${fieldId}-field8`}>
                  <Trans>API credential</Trans>
                </label>
                <Input
                  id={`${fieldId}-field8`}
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={
                    entry?.hasSecret ? t`Leave empty to keep the saved credential` : undefined
                  }
                  required={!entry?.hasSecret}
                  maxLength={16384}
                />
              </div>
            ) : null}
            <details>
              <summary className="cursor-pointer text-sm">
                <Trans>Request parameters</Trans>
              </summary>
              <div className="mt-3 grid gap-3">
                <div className="grid gap-1.5 text-sm">
                  <label htmlFor={`${fieldId}-field9`}>
                    <Trans>Query parameters (JSON)</Trans>
                  </label>
                  <Textarea
                    id={`${fieldId}-field9`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    rows={4}
                  />
                </div>
                {method === "POST" ? (
                  <div className="grid gap-1.5 text-sm">
                    <label htmlFor={`${fieldId}-field10`}>
                      <Trans>Request body</Trans>
                    </label>
                    <Textarea
                      id={`${fieldId}-field10`}
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      rows={4}
                      maxLength={32000}
                    />
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  <Trans>Use the credential field for keys and tokens.</Trans>
                </p>
              </div>
            </details>
          </>
        ) : (
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={`${fieldId}-field11`}>
              <Trans>MCP connection</Trans>
            </label>
            <NativeSelect
              id={`${fieldId}-field11`}
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
              required
            >
              <NativeSelectOption value="">{t`Select a connection`}</NativeSelectOption>
              {servers.data?.map((server) => (
                <NativeSelectOption key={server.id} value={server.id}>
                  {server.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {servers.isError ? (
              <span role="alert">{errorText(servers.error)}</span>
            ) : !servers.isPending && !servers.data?.length ? (
              <span className="text-xs text-muted-foreground">
                <Trans>Add an MCP connection in Integrations first.</Trans>
              </span>
            ) : null}
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending || !name.trim()}>
            <Trans>Save interface</Trans>
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </form>
      {identityDialog}
    </>
  );
}
