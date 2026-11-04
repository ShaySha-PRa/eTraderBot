import { Trans, useLingui } from "@lingui/react/macro";
import type { TradingWorkspace } from "@rakazo/contracts";
import { TradingWorkspaceScopeSchema } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Layers, Plus, Settings2 } from "lucide-react";
import { useId, useState } from "react";
import { useQueryUserId, useSpaceQueries } from "../../lib/query";
import { useTradingActions } from "../../lib/trading-actions";

export function BusinessScopePicker({
  scopes,
  selected,
  pending,
  mini,
  onSelect,
  onCreate,
  onInterfaces,
  onExpand,
}: {
  scopes: { id: string; name: string; kind: string; isolationPending: boolean }[];
  selected: string;
  pending: boolean;
  mini: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onInterfaces: () => void;
  onExpand: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  if (mini)
    return (
      <Button variant="ghost" size="icon" aria-label={t`Workspace`} onClick={onExpand}>
        <Layers size={18} />
      </Button>
    );
  return (
    <section
      aria-label={t`Workspace`}
      className="mx-2.5 mb-3 grid gap-2 rounded-xl border bg-card p-3"
      data-testid="business-scope-picker"
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          <Trans>Workspace</Trans>
        </label>
        <Button size="icon-xs" variant="ghost" aria-label={t`New workspace`} onClick={onCreate}>
          <Plus size={14} />
        </Button>
      </div>
      <NativeSelect
        id={id}
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
        disabled={pending}
        className="w-full"
      >
        <NativeSelectOption value="">{t`All bots`}</NativeSelectOption>
        {scopes.map((scope) => (
          <NativeSelectOption key={scope.id} value={scope.id}>
            {scope.name} · {scope.kind === "trading" ? t`Trading` : t`General`}
            {scope.isolationPending ? ` · ${t`Migration required`}` : ""}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {scopes.find((scope) => scope.id === selected)?.kind === "trading" ? (
        <Button variant="ghost" size="sm" className="justify-start" onClick={onInterfaces}>
          <Settings2 size={14} />
          <Trans>Interface settings</Trans>
        </Button>
      ) : null}
    </section>
  );
}

export function BusinessScopeDialog({
  configure,
  onClose,
  onCreated,
}: {
  configure?: { name: string };
  onClose: () => void;
  onCreated: (scope: { spaceId: string; id: string }) => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const queries = useSpaceQueries();
  const people = useQuery(queries.trading.participants.queryOptions({ input: {} }));
  const { api, act, pending, error, identityDialog } = useTradingActions();
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(configure?.name ?? "");
  const [kind, setKind] = useState<"general" | "trading">("trading");
  const fieldId = useId();
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !pending) onClose();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
          aria-describedby={undefined}
          data-testid="business-scope-dialog"
        >
          <form
            className="grid gap-4"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                if (event.key === "Escape") event.stopPropagation();
                if (event.key === "Enter") event.preventDefault();
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void act(async () => {
                if (kind === "general") {
                  const saved = await api.spaces.create({ name, kind });
                  onCreated({ id: saved.id, spaceId: saved.id });
                  return;
                }
                const scope = TradingWorkspaceScopeSchema.parse({
                  subjectId: values.get("subjectId"),
                  subjectKind: values.get("subjectKind"),
                  accountId: values.get("accountId"),
                  assetId: values.get("assetId"),
                  region: values.get("region"),
                  marketId: values.get("marketId"),
                  productId: "energy",
                  environment: "simulation",
                });
                const saved = await (configure
                  ? api.trading.createWorkspace
                  : api.trading.createBusinessScope)({
                  id,
                  name,
                  scope,
                  algorithmApproverUserId: String(values.get("algorithmApproverUserId")),
                  tradeApproverUserId: String(values.get("tradeApproverUserId")),
                });
                onCreated(saved);
              }, kind === "trading");
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {configure ? t`Configure business scope` : t`New workspace`}
              </DialogTitle>
            </DialogHeader>
            {!configure ? (
              <div className="grid gap-1.5 text-sm">
                <label htmlFor={`${fieldId}-kind`}>
                  <Trans>Workspace type</Trans>
                </label>
                <NativeSelect
                  id={`${fieldId}-kind`}
                  value={kind}
                  onChange={(event) => setKind(event.target.value as "general" | "trading")}
                >
                  <NativeSelectOption value="trading">{t`Trading workspace`}</NativeSelectOption>
                  <NativeSelectOption value="general">{t`General workspace`}</NativeSelectOption>
                </NativeSelect>
              </div>
            ) : null}
            <div className="grid gap-1.5 text-sm">
              <label htmlFor={`${fieldId}-field1`}>
                <Trans>Name</Trans>
              </label>
              <Input
                id={`${fieldId}-field1`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t`For example: Shandong retail trading`}
                required
                maxLength={60}
                readOnly={Boolean(configure)}
              />
            </div>
            {kind === "trading" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5 text-sm">
                    <label htmlFor={`${fieldId}-field2`}>
                      <Trans>Subject type</Trans>
                    </label>
                    <NativeSelect
                      id={`${fieldId}-field2`}
                      name="subjectKind"
                      defaultValue="retailer"
                    >
                      <NativeSelectOption value="retailer">{t`Retailer`}</NativeSelectOption>
                      <NativeSelectOption value="generator">{t`Generator`}</NativeSelectOption>
                      <NativeSelectOption value="storage">{t`Storage`}</NativeSelectOption>
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5 text-sm">
                    <label htmlFor={`${fieldId}-field3`}>
                      <Trans>Region</Trans>
                    </label>
                    <NativeSelect id={`${fieldId}-field3`} name="region" defaultValue="CN-SD">
                      <NativeSelectOption value="CN-SH">{t`Shanghai`}</NativeSelectOption>
                      <NativeSelectOption value="CN-JS">{t`Jiangsu · Suzhou`}</NativeSelectOption>
                      <NativeSelectOption value="CN-SD">{t`Shandong`}</NativeSelectOption>
                    </NativeSelect>
                  </div>
                  {[
                    ["subjectId", t`Subject ID`, "demo-subject"],
                    ["accountId", t`Account ID`, "demo-account"],
                    ["assetId", t`Asset ID`, "demo-asset"],
                    ["marketId", t`Market ID`, "simulation-energy"],
                  ].map(([key, label, value]) => (
                    <div key={key} className="grid gap-1.5 text-sm">
                      <label htmlFor={`${fieldId}-${key}`}>{label}</label>
                      <Input
                        id={`${fieldId}-${key}`}
                        name={key}
                        defaultValue={value}
                        required
                        maxLength={128}
                      />
                    </div>
                  ))}
                </div>
                <SectionHeading>
                  <Trans>Human approvals</Trans>
                </SectionHeading>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    ["algorithmApproverUserId", t`Algorithm approver`],
                    ["tradeApproverUserId", t`Trade authorizer`],
                  ].map(([key, label]) => (
                    <div key={key} className="grid gap-1.5 text-sm">
                      <label htmlFor={`${fieldId}-${key}`}>{label}</label>
                      <NativeSelect id={`${fieldId}-${key}`} name={key} defaultValue={userId ?? ""}>
                        {people.data
                          ?.filter((member) => configure || member.id === userId)
                          .map((member) => (
                            <NativeSelectOption key={member.id} value={member.id}>
                              {member.name}
                            </NativeSelectOption>
                          ))}
                      </NativeSelect>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    Simulation · bots and interfaces are configured within this business scope.
                  </Trans>
                </p>
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                type="submit"
                disabled={pending || !name.trim() || (kind === "trading" && !people.data?.length)}
              >
                {configure ? t`Save configuration` : t`Create workspace`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {identityDialog}
    </>
  );
}

export function BusinessScopeEmpty({
  workspace,
  onCreate,
}: {
  workspace: TradingWorkspace;
  onCreate: () => void;
}) {
  const owner = useQueryUserId() === workspace.ownerUserId;
  return (
    <div className="grid flex-1 content-center justify-items-center gap-4 p-6">
      <h1 className="text-lg font-medium">{workspace.name}</h1>
      <p className="text-sm text-muted-foreground">
        <Trans>No bots in this business scope yet.</Trans>
      </p>
      {owner ? (
        <Button onClick={onCreate}>
          <Plus size={16} />
          <Trans>New bot</Trans>
        </Button>
      ) : null}
    </div>
  );
}
