import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  HandoffCatalogSourceType,
  HandoffItem,
  HandoffPackage,
  HandoffPlan,
  HandoffReceipt,
} from "@rakazo/contracts";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Switch,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { useIdentityConfirmation } from "../components/ConfirmIdentityDialog";
import { useSpaceQueries } from "../lib/query";
import { SpaceRpcProvider, useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

export type ExperienceMode = "export" | "import";
type HandoffPreview = Awaited<
  ReturnType<ReturnType<typeof useSpaceRpc>["experienceHandoff"]["preview"]>
>;

/**
 * Export from a source Bot or import into a target Bot. Calls run in the Bot's own space: the
 * source space when exporting, the target space when importing, as the handoff contract requires.
 */
export function ExperienceHandoffPage({
  bot,
  mode,
  onClose,
}: {
  bot: Bot;
  mode: ExperienceMode;
  onClose: () => void;
}) {
  return (
    <SpaceRpcProvider spaceId={bot.spaceId}>
      <div className="min-h-0 flex-1 overflow-auto p-4" data-testid={`experience-${mode}`}>
        <div className="mx-auto max-w-4xl space-y-5">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              <ArrowLeft size={16} aria-hidden="true" />
              <Trans>Back</Trans>
            </Button>
            <SectionHeading>
              {mode === "export" ? (
                <Trans>Export experience</Trans>
              ) : (
                <Trans>Import experience</Trans>
              )}
            </SectionHeading>
          </div>
          {mode === "export" ? <ExportExperience bot={bot} /> : <ImportExperience bot={bot} />}
        </div>
      </div>
    </SpaceRpcProvider>
  );
}

/** Shared pending/error state; refusals read in the interface language by their stable reason. */
function useHandoffAction() {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const conflicts = useConflictText();
  const [pending, setPending] = useState(false);
  // The failure itself is kept, not its text, so a language switch rewords it at once.
  const [failure, setFailure] = useState<{ reason: string | null; cause: unknown } | null>(null);
  const refusals: Record<string, string> = {
    FORBIDDEN: t`You don't have access to this Bot or workspace`,
    NOT_FOUND: t`This package or Bot is no longer available`,
    CONFLICT: t`This changed meanwhile. Reload and try again`,
    SOURCE_CHANGED: t`The selected content changed. Reload and choose again`,
    STALE_PREVIEW: t`The target changed. Preview again before importing`,
    PACKAGE_REVOKED: t`This package was revoked`,
    MEMORY_PROVIDER_UNSUPPORTED: t`External memory can't be exported or imported`,
    INVALID_INPUT: t`Check the entries and try again`,
    ...conflicts,
  };
  /** Runs an action; on refusal records it and reports its stable reason to `onRefused`. */
  async function run<T>(
    action: () => Promise<T>,
    human = false,
    onRefused?: (reason: string | null) => void,
  ): Promise<T | undefined> {
    setPending(true);
    setFailure(null);
    try {
      return await (human ? withIdentityConfirmation(action) : action());
    } catch (cause) {
      if (isIdentityConfirmationRequired(cause)) return undefined;
      const data =
        cause && typeof cause === "object" && "data" in cause
          ? (cause.data as Record<string, unknown> | undefined)
          : undefined;
      const reason = typeof data?.reason === "string" ? data.reason : null;
      setFailure({ reason, cause });
      onRefused?.(reason);
      return undefined;
    } finally {
      setPending(false);
    }
  }
  const error = !failure
    ? ""
    : failure.reason
      ? (refusals[failure.reason] ?? t`Could not continue`)
      : errorText(failure.cause, t`Could not continue`);
  /** Drops a shown failure once the user has dealt with it. */
  const clear = () => setFailure(null);
  return { run, pending, error, clear, identityDialog };
}

/** Why a planned item cannot be copied under its name; preview reports these per item. */
function useConflictText(): Record<string, string> {
  const { t } = useLingui();
  return {
    TARGET_EXISTS: t`This Bot already has something with this name`,
    DUPLICATE_TARGET: t`Another item in this import uses the same name`,
    BUILTIN_SKILL_NAME: t`This name is reserved for a built-in Skill`,
  };
}

function loadError(error: unknown) {
  return error ? errorText(error) : "";
}

function ErrorLine({ text }: { text: string }) {
  return text ? (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  ) : null;
}

function useSourceLabels(): Record<HandoffCatalogSourceType, string> {
  const { t } = useLingui();
  return {
    bot_memory: t`This Bot's memory`,
    shared_memory: t`Shared memory`,
    workspace_skill: t`Workspace Skill`,
    imported_skill: t`Imported Skill`,
  };
}

function useKindLabels() {
  const { t } = useLingui();
  return { summary: t`Summary`, memory: t`Memory`, skill: t`Skill` } as const;
}

function ExportExperience({ bot }: { bot: Bot }) {
  const { t } = useLingui();
  const ids = useId();
  const api = useSpaceRpc(),
    queries = useSpaceQueries(),
    cache = useQueryClient();
  const sources = useSourceLabels();
  const kinds = useKindLabels();
  const { run, pending, error, identityDialog } = useHandoffAction();
  const catalog = useQuery(
    queries.experienceHandoff.catalog.queryOptions({ input: { sourceBotId: bot.id } }),
  );
  const packages = useQuery(
    queries.experienceHandoff.packages.queryOptions({ input: { limit: 100 } }),
  );
  const history = useQuery(
    queries.experienceHandoff.history.queryOptions({ input: { botId: bot.id, limit: 50 } }),
  );
  const own = (packages.data?.items ?? []).filter((p) => p.sourceBotId === bot.id);
  // Only the newest version of each line can take a successor.
  const latest = own.filter(
    (p) => !own.some((o) => o.lineageId === p.lineageId && o.version > p.version),
  );
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [summaries, setSummaries] = useState<{ title: string; content: string }[]>([]);
  const [conditions, setConditions] = useState([""]);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [previous, setPrevious] = useState("");
  // One idempotency key per package being written; retries of the same request reuse it.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [created, setCreated] = useState<string | null>(null);
  const chosen = (catalog.data ?? []).filter((c) => picked.includes(c.id));
  const filledSummaries = summaries.filter((s) => s.title.trim() && s.content.trim());
  const filledConditions = conditions.map((c) => c.trim()).filter(Boolean);
  const ready =
    title.trim() && filledConditions.length && (chosen.length || filledSummaries.length);

  async function create() {
    const pkg = await run(
      () =>
        api.experienceHandoff.create({
          requestId,
          sourceBotId: bot.id,
          ...(previous ? { previousPackageId: previous } : {}),
          title: title.trim(),
          applicability: {
            conditions: filledConditions,
            limitations: limitations.map((l) => l.trim()).filter(Boolean),
          },
          summaries: filledSummaries.map((s) => ({ title: s.title.trim(), content: s.content })),
          memories: chosen
            .filter((c) => c.kind === "memory")
            .map(({ id, revision }) => ({ id, revision })),
          skills: chosen
            .filter((c) => c.kind === "skill")
            .map(({ id, revision }) => ({ id, revision })),
        }),
      true,
    );
    if (!pkg) return;
    setCreated(pkg.id);
    setTitle("");
    setPicked([]);
    setSummaries([]);
    setConditions([""]);
    setLimitations([]);
    setPrevious("");
    setRequestId(crypto.randomUUID());
    await cache.invalidateQueries({ queryKey: queries.experienceHandoff.key() });
  }

  return (
    <>
      {identityDialog}
      <section className="space-y-3 rounded border p-3">
        <label htmlFor={`${ids}-title`} className="grid gap-1 text-sm">
          {t`Package title`}
          <Input id={`${ids}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {latest.length ? (
          <NativeSelect
            aria-label={t`Version`}
            className="max-w-full"
            value={previous}
            onChange={(e) => setPrevious(e.target.value)}
          >
            <NativeSelectOption value="">{t`New package`}</NativeSelectOption>
            {latest.map(({ id, version, snapshot: { title: packageTitle } }) => (
              <NativeSelectOption key={id} value={id}>
                {t`Next version of ${packageTitle} v${version}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t`Content`}</legend>
          {catalog.data?.length ? (
            catalog.data.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-labelledby={`${ids}-${c.id}-source ${ids}-${c.id}`}
                  checked={picked.includes(c.id)}
                  onCheckedChange={(checked) =>
                    setPicked((all) => (checked ? [...all, c.id] : all.filter((id) => id !== c.id)))
                  }
                />
                {/* Where it comes from, so same-named Bot and shared memories differ before ticking. */}
                <Badge variant="outline" id={`${ids}-${c.id}-source`}>
                  {sources[c.sourceType] ?? kinds[c.kind]}
                </Badge>
                <span id={`${ids}-${c.id}`} className="min-w-0 break-words">
                  {c.title}
                </span>
              </div>
            ))
          ) : catalog.isSuccess ? (
            <p className="text-sm text-muted-foreground">{t`No memory or Skill to export yet`}</p>
          ) : null}
          {summaries.map((s, index) => (
            <div key={index} className="grid gap-2 rounded border p-2">
              <Input
                aria-label={t`Summary title`}
                value={s.title}
                onChange={(e) =>
                  setSummaries((all) =>
                    all.map((row, i) => (i === index ? { ...row, title: e.target.value } : row)),
                  )
                }
              />
              <Textarea
                aria-label={t`Summary`}
                value={s.content}
                onChange={(e) =>
                  setSummaries((all) =>
                    all.map((row, i) => (i === index ? { ...row, content: e.target.value } : row)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={() => setSummaries((all) => all.filter((_, i) => i !== index))}
              >
                <Trans>Remove</Trans>
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSummaries((all) => [...all, { title: "", content: "" }])}
          >
            <Trans>Add summary</Trans>
          </Button>
        </fieldset>
        <TextList
          legend={t`Applies when`}
          itemLabel={t`Condition`}
          values={conditions}
          onChange={setConditions}
          minimum={1}
        />
        <TextList
          legend={t`Known limitations`}
          itemLabel={t`Limitation`}
          values={limitations}
          onChange={setLimitations}
          minimum={0}
        />
        <ErrorLine text={error || loadError(catalog.error ?? packages.error)} />
        <Button disabled={pending || !ready} onClick={() => void create()}>
          <Trans>Create package</Trans>
        </Button>
      </section>
      <section className="space-y-2">
        <SectionHeading>
          <Trans>Packages</Trans>
        </SectionHeading>
        {own.map((p) => (
          <PackageView
            key={p.id}
            pkg={p}
            open={p.id === created}
            action={
              p.revokedAt ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await api.experienceHandoff.revoke({ packageId: p.id });
                      await cache.invalidateQueries({ queryKey: queries.experienceHandoff.key() });
                    }, true)
                  }
                >
                  <Trans>Revoke</Trans>
                </Button>
              )
            }
          />
        ))}
      </section>
      <HistoryList receipts={(history.data?.items ?? []).filter((r) => r.sourceBotId === bot.id)} />
    </>
  );
}

function TextList({
  legend,
  itemLabel,
  values,
  onChange,
  minimum,
}: {
  legend: string;
  itemLabel: string;
  values: string[];
  onChange: (values: string[]) => void;
  minimum: number;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {values.map((value, index) => (
        <div key={index} className="flex gap-2">
          <Input
            aria-label={`${itemLabel} ${index + 1}`}
            value={value}
            onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
          />
          {values.length > minimum ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <Trans>Remove</Trans>
            </Button>
          ) : null}
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...values, ""])}>
        <Trans>Add</Trans>
      </Button>
    </fieldset>
  );
}

/** A fixed package: source, applicability and the exact items it carries. */
function PackageView({
  pkg,
  open,
  action,
}: {
  pkg: HandoffPackage;
  open?: boolean;
  action?: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <details
      className="rounded border p-3 text-sm"
      open={open}
      data-testid={`handoff-package-${pkg.id}`}
    >
      <summary className="cursor-pointer break-words">
        {pkg.snapshot.title} · v{pkg.version} · {new Date(pkg.createdAt).toLocaleString()}
        {pkg.revokedAt ? ` · ${t`Revoked`}` : ""}
      </summary>
      <PackageBody pkg={pkg} />
      {action ? <div className="mt-2">{action}</div> : null}
    </details>
  );
}

function PackageBody({ pkg }: { pkg: HandoffPackage }) {
  const { t } = useLingui();
  const kinds = useKindLabels();
  const { snapshot } = pkg;
  return (
    <div className="mt-2 space-y-2">
      <p className="break-words">
        {t`Source`}: {snapshot.sourceBotName} · {snapshot.sourceSpaceName} ·{" "}
        {snapshot.sourceWorkspaceKind === "trading" ? t`Trading` : t`General`}
      </p>
      <p className="break-all text-muted-foreground">
        v{pkg.version} · {pkg.contentHash}
      </p>
      <div>
        <p className="font-medium">{t`Applies when`}</p>
        <ul className="list-disc ps-5">
          {snapshot.applicability.conditions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
      {snapshot.applicability.limitations.length ? (
        <div>
          <p className="font-medium">{t`Known limitations`}</p>
          <ul className="list-disc ps-5">
            {snapshot.applicability.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="space-y-1">
        {snapshot.items.map((item) => (
          <li key={item.key}>
            <ItemView item={item} kind={kinds[item.kind]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemView({ item, kind }: { item: HandoffItem; kind: string }) {
  return (
    <details className="rounded bg-muted/40 p-2">
      <summary className="cursor-pointer break-words">
        <Badge variant="outline" className="me-2">
          {kind}
        </Badge>
        {item.title}
        {item.sourceRevision !== "user-selected" ? ` · ${item.sourceRevision}` : ""}
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
        {item.content}
      </pre>
    </details>
  );
}

function ImportExperience({ bot }: { bot: Bot }) {
  const { t } = useLingui();
  const api = useSpaceRpc(),
    queries = useSpaceQueries(),
    cache = useQueryClient();
  const kinds = useKindLabels();
  const { run, pending, error, identityDialog } = useHandoffAction();
  const packages = useQuery(
    queries.experienceHandoff.packages.queryOptions({ input: { limit: 100 } }),
  );
  const history = useQuery(
    queries.experienceHandoff.history.queryOptions({ input: { botId: bot.id, limit: 50 } }),
  );
  const skills = useQuery(
    queries.experienceHandoff.skills.queryOptions({ input: { botId: bot.id } }),
  );
  const [packageId, setPackageId] = useState("");
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [plan, setPlan] = useState<HandoffPlan>([]);
  // A changed plan, or a preview the server called stale, must be previewed again before confirming.
  const [needsPreview, setNeedsPreview] = useState(false);
  const [receipt, setReceipt] = useState<HandoffReceipt | null>(null);
  const conflicts = useConflictText();
  const received = (history.data?.items ?? []).filter((r) => r.targetBotId === bot.id);

  async function check(id: string, next?: HandoffPlan) {
    const result = await run(() =>
      api.experienceHandoff.preview({
        packageId: id,
        targetBotId: bot.id,
        ...(next ? { plan: next } : {}),
      }),
    );
    if (!result) return;
    setPreview(result);
    setPlan(result.plan);
    setNeedsPreview(false);
  }
  async function confirm() {
    if (!preview) return;
    const done = await run(
      () =>
        api.experienceHandoff.confirm({
          packageId: preview.package.id,
          targetBotId: bot.id,
          plan,
          previewHash: preview.previewHash,
        }),
      true,
      // The target moved on since this preview: keep the plan and require a fresh preview.
      (reason) => {
        if (reason === "STALE_PREVIEW") setNeedsPreview(true);
      },
    );
    if (!done) return;
    setReceipt(done);
    setPreview(null);
    setPackageId("");
    await cache.invalidateQueries({ queryKey: queries.experienceHandoff.key() });
  }
  function edit(itemKey: string, patch: Partial<HandoffPlan[number]>) {
    setPlan((all) => all.map((row) => (row.itemKey === itemKey ? { ...row, ...patch } : row)));
    setNeedsPreview(true);
  }

  return (
    <>
      {identityDialog}
      <section className="space-y-3 rounded border p-3">
        <NativeSelect
          aria-label={t`Package`}
          className="max-w-full"
          value={packageId}
          onChange={(e) => {
            const id = e.target.value;
            setPackageId(id);
            setPreview(null);
            setReceipt(null);
            if (id) void check(id);
          }}
        >
          <NativeSelectOption value="">{t`Choose a package`}</NativeSelectOption>
          {(packages.data?.items ?? [])
            .filter((p) => !p.revokedAt)
            .map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {`${p.snapshot.title} · v${p.version} · ${p.snapshot.sourceBotName} · ${p.snapshot.sourceSpaceName}`}
              </NativeSelectOption>
            ))}
        </NativeSelect>
        <ErrorLine text={error || loadError(packages.error)} />
        {preview ? (
          <div className="space-y-3" data-testid="handoff-preview">
            <PackageBody pkg={preview.package} />
            {preview.alreadyImported ? (
              <div className="space-y-1">
                <p>{t`Already imported to this Bot`}</p>
                <ReceiptItems receipt={preview.alreadyImported} />
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {preview.package.snapshot.items.map((item) => {
                    const row = plan.find((r) => r.itemKey === item.key);
                    const itemTitle = item.title;
                    const conflict = needsPreview
                      ? null
                      : preview.conflicts.find((c) => c.itemKey === item.key);
                    if (!row) return null;
                    return (
                      <li
                        key={item.key}
                        className="grid gap-1 rounded border p-2 text-sm"
                        data-testid={`handoff-plan-${item.key}`}
                      >
                        <span className="break-words">
                          <Badge variant="outline" className="me-2">
                            {kinds[item.kind]}
                          </Badge>
                          {item.title}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          <NativeSelect
                            aria-label={t`Action for ${itemTitle}`}
                            value={row.action}
                            onChange={(e) =>
                              edit(item.key, { action: e.target.value as "copy" | "skip" })
                            }
                          >
                            <NativeSelectOption value="copy">{t`Copy`}</NativeSelectOption>
                            <NativeSelectOption value="skip">{t`Skip`}</NativeSelectOption>
                          </NativeSelect>
                          <Input
                            aria-label={t`Name in this Bot for ${itemTitle}`}
                            aria-invalid={conflict ? true : undefined}
                            className="min-w-0 flex-1"
                            disabled={row.action === "skip"}
                            value={row.targetName}
                            onChange={(e) => edit(item.key, { targetName: e.target.value })}
                          />
                        </div>
                        {conflict ? (
                          <p className="text-destructive">
                            {conflicts[conflict.reason] ?? t`Could not continue`}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={pending || !needsPreview}
                    onClick={() => void check(preview.package.id, plan)}
                  >
                    <Trans>Preview again</Trans>
                  </Button>
                  <Button
                    disabled={pending || needsPreview || preview.conflicts.length > 0}
                    onClick={() => void confirm()}
                  >
                    <Trans>Import</Trans>
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}
        {receipt ? (
          <div className="space-y-1" data-testid="handoff-receipt">
            <p>{t`Imported`}</p>
            <ReceiptItems receipt={receipt} />
          </div>
        ) : null}
      </section>
      <section className="space-y-2" data-testid="imported-experience">
        <SectionHeading>
          <Trans>Imported experience</Trans>
        </SectionHeading>
        {received.flatMap((r) =>
          r.items
            .filter((item) => item.kind !== "skill" && item.status === "copied")
            .map((item) => (
              <p key={`${r.id}:${item.itemKey}`} className="break-words text-sm">
                {item.targetName} · {r.sourceBotName} v{r.packageVersion}
              </p>
            )),
        )}
      </section>
      <ImportedSkills bot={bot} skills={skills.data ?? []} />
      <HistoryList receipts={received} />
    </>
  );
}

type HandoffSkill = NonNullable<
  Awaited<ReturnType<ReturnType<typeof useSpaceRpc>["experienceHandoff"]["skills"]>>
>[number];

/** Imported Skills stay off until the user enables them, unlike imported memory. */
function ImportedSkills({ bot, skills }: { bot: Bot; skills: HandoffSkill[] }) {
  if (!skills.length) return null;
  return (
    <section className="space-y-2" data-testid="imported-skills">
      <SectionHeading>
        <Trans>Imported Skills</Trans>
      </SectionHeading>
      {skills.map((skill) => (
        <ImportedSkillRow key={skill.id} bot={bot} skill={skill} />
      ))}
    </section>
  );
}

/**
 * One imported Skill: its state, the enable switch, and editing of this Bot's own copy. Edits go
 * through `updateSkill` with the revision read when editing began; a newer save elsewhere is never
 * overwritten silently, and the draft survives every refusal.
 */
function ImportedSkillRow({ bot, skill }: { bot: Bot; skill: HandoffSkill }) {
  const { t } = useLingui();
  const ids = useId();
  const api = useSpaceRpc(),
    queries = useSpaceQueries(),
    cache = useQueryClient();
  const { run, pending, error, clear, identityDialog } = useHandoffAction();
  const skillsKey = queries.experienceHandoff.skills.queryKey({ input: { botId: bot.id } });
  // `draft` is null while not editing; `basis` is the revision the draft was written against.
  const [draft, setDraft] = useState<string | null>(null);
  const [basis, setBasis] = useState(skill.revision);
  const [invalid, setInvalid] = useState<"format" | "name" | null>(null);
  // Set when another save landed first: the newer copy, kept apart from the draft.
  const [newer, setNewer] = useState<HandoffSkill | null>(null);
  const [nameTaken, setNameTaken] = useState(false);
  const editing = draft !== null;
  const skillName = skill.name;
  const editorId = `${ids}-${skill.id}-content`;

  function edit(value: string | null) {
    setDraft(value);
    setInvalid(null);
    setNameTaken(false);
  }
  async function save() {
    if (draft === null) return;
    // The shared SKILL.md parser catches what the server would refuse, before a round trip.
    const parsed = parseSkillMd(draft);
    if ("error" in parsed) return setInvalid("format");
    if (parsed.name !== skill.name) return setInvalid("name");
    setInvalid(null);
    setNameTaken(false);
    const saved = await run(
      () =>
        api.experienceHandoff.updateSkill({
          skillId: skill.id,
          expectedRevision: basis,
          content: draft,
        }),
      true,
      (reason) => {
        if (reason === "CONFLICT") void explainConflict();
      },
    );
    if (!saved) return;
    edit(null);
    setNewer(null);
    await cache.invalidateQueries({ queryKey: skillsKey });
  }
  /** CONFLICT means either a newer revision exists or the enabled copy's name is now taken. */
  async function explainConflict() {
    const latest = (await cache.fetchQuery({
      ...queries.experienceHandoff.skills.queryOptions({ input: { botId: bot.id } }),
      staleTime: 0,
    })) as HandoffSkill[];
    const current = latest.find((row) => row.id === skill.id);
    if (current && current.revision !== basis) setNewer(current);
    else setNameTaken(true);
  }

  return (
    <div
      className="space-y-2 rounded border p-3 text-sm"
      data-testid={`imported-skill-${skill.name}`}
    >
      {identityDialog}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-medium" id={`${ids}-${skill.id}`}>
            {skill.name}
          </p>
          {skill.description ? (
            <p className="break-words text-muted-foreground">{skill.description}</p>
          ) : null}
          <p className="text-muted-foreground">
            {!skill.enabledAt
              ? t`Waiting to be enabled`
              : skill.blockedReason
                ? t`Paused: a shared Skill uses this name`
                : t`Enabled`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editing ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBasis(skill.revision);
                setNewer(null);
                edit(skill.content);
              }}
            >
              <Trans>Edit</Trans>
            </Button>
          )}
          <Switch
            aria-labelledby={`${ids}-${skill.id}`}
            checked={Boolean(skill.enabledAt)}
            disabled={pending}
            onCheckedChange={(enabled) =>
              void run(async () => {
                const updated = await api.experienceHandoff.updateSkill({
                  skillId: skill.id,
                  expectedRevision: skill.revision,
                  enabled,
                });
                // This row's own toggle must not outdate its draft; only when nothing else changed
                // since the draft began, so another page's newer text is never skipped over.
                if (editing && basis === skill.revision) setBasis(updated.revision);
                setNameTaken(false);
                await cache.invalidateQueries({ queryKey: skillsKey });
              }, true)
            }
          />
        </div>
      </div>
      {editing ? (
        <div className="grid gap-2">
          <Textarea
            id={editorId}
            aria-label={t`SKILL.md for ${skillName}`}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={
              invalid || nameTaken || newer || error ? `${editorId}-error` : undefined
            }
            className="min-h-48 font-mono text-xs"
            value={draft}
            onChange={(e) => edit(e.target.value)}
          />
          <div id={`${editorId}-error`} className="space-y-2">
            {invalid === "format" ? (
              <ErrorLine text={t`Needs SKILL.md frontmatter with a name and description`} />
            ) : invalid === "name" ? (
              <ErrorLine text={t`Keep the name ${skillName}`} />
            ) : nameTaken ? (
              <ErrorLine
                text={t`Another Skill already uses this name. Disable this copy to save it`}
              />
            ) : newer ? (
              <div className="space-y-2" data-testid="imported-skill-newer">
                <ErrorLine text={t`This Skill changed elsewhere. Your draft is kept`} />
                <details className="rounded bg-muted/40 p-2">
                  <summary className="cursor-pointer">{t`Latest version`}</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {newer.content}
                  </pre>
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setBasis(newer.revision);
                      edit(newer.content);
                      setNewer(null);
                      // The conflict is resolved; its refusal no longer applies.
                      clear();
                    }}
                  >
                    <Trans>Use latest version</Trans>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Write the draft against the newer revision; saving still asks again.
                      setBasis(newer.revision);
                      setNewer(null);
                      clear();
                    }}
                  >
                    <Trans>Keep my draft</Trans>
                  </Button>
                </div>
              </div>
            ) : (
              <ErrorLine text={error} />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending || Boolean(newer)} onClick={() => void save()}>
              <Trans>Save</Trans>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                edit(null);
                setNewer(null);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <ErrorLine text={error} />
      )}
    </div>
  );
}

function ReceiptItems({ receipt }: { receipt: HandoffReceipt }) {
  const { t } = useLingui();
  const kinds = useKindLabels();
  const status = { copied: t`Copied`, pending: t`Waiting to be enabled`, skipped: t`Skipped` };
  return (
    <ul className="space-y-1 text-sm">
      {receipt.items.map((item) => (
        <li key={item.itemKey} className="break-words">
          <Badge variant="outline" className="me-2">
            {kinds[item.kind]}
          </Badge>
          {item.targetName} · {status[item.status]}
        </li>
      ))}
    </ul>
  );
}

/** Each import with its source, target and the package exactly as it was when imported. */
function HistoryList({ receipts }: { receipts: HandoffReceipt[] }) {
  if (!receipts.length) return null;
  return (
    <section className="space-y-2" data-testid="handoff-history">
      <SectionHeading>
        <Trans>Handoff history</Trans>
      </SectionHeading>
      {receipts.map((r) => (
        <HistoryEntry key={r.id} receipt={r} />
      ))}
    </section>
  );
}

function HistoryEntry({ receipt }: { receipt: HandoffReceipt }) {
  const queries = useSpaceQueries();
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    ...queries.experienceHandoff.importDetail.queryOptions({ input: { importId: receipt.id } }),
    enabled: open,
  });
  return (
    <details
      className="rounded border p-3 text-sm"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      data-testid={`handoff-import-${receipt.id}`}
    >
      <summary className="cursor-pointer break-words">
        {new Date(receipt.createdAt).toLocaleString()} · {receipt.sourceBotName} →{" "}
        {receipt.targetBotName} · v{receipt.packageVersion}
      </summary>
      <div className="mt-2 space-y-2">
        <ReceiptItems receipt={receipt} />
        {detail.data ? <PackageBody pkg={detail.data.package} /> : null}
      </div>
    </details>
  );
}
