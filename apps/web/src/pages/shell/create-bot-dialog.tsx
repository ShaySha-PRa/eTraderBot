import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet, TradingBotRole } from "@rakazo/contracts";
import {
  BOT_NAME_MAX_LENGTH,
  DEFAULT_NEW_BOT_AVATAR_SET,
  TradingBotRoleSchema,
} from "@rakazo/contracts";
import {
  newClientId,
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarFamily,
  organicAvatarSampleIdentity,
} from "@rakazo/core";
import {
  BOT_AVATAR_COLORS,
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  parseBotAvatar,
} from "@rakazo/ui-web";
import { useState } from "react";
import { useTradingBotTemplates } from "../../lib/trading-bot-templates";
import { errorText } from "../../lib/user-error";
import { BotLookPicker } from "./avatar-studio-popover";

/** One preview identity per organic look, so the dialog can show a body before the bot has an id. */
const ORGANIC_IDENTITIES = ORGANIC_AVATAR_LOOKS.map(organicAvatarSampleIdentity);

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

export interface CreateBotDialogInput {
  tradingRole?: TradingBotRole;
  tradingWorkspaceId?: string;
  spawnKey?: string;
  name: string;
  color: string;
  /** Reserve the logo preview's persistent seed through creation and retries. */
  id?: string;
  avatarSet: BotAvatarSet;
  /** The organic family the preview drew; omitted when a studio shape is picked. */
  avatarFamily?: number;
}

/** Mounted only while open; the parent unmounts it from `onCancel` or after `onCreate`. */
export function CreateBotDialog({
  onCancel,
  onCreate,
  businessScope,
  workspaceKind = "general",
  isolationPending = false,
  onChooseScope,
}: {
  businessScope?: { id: string; name: string };
  workspaceKind?: "general" | "trading";
  isolationPending?: boolean;
  onChooseScope?: () => void;
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const templates = useTradingBotTemplates();
  const [role, setRole] = useState<TradingBotRole | null>(
    workspaceKind === "trading" ? "spot" : null,
  );
  const [name, setName] = useState(workspaceKind === "trading" ? templates.spot.name : "");
  const [previewId] = useState(() => {
    let id: string;
    do {
      id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
    } while (organicAvatarFamily(id) === ORGANIC_AVATAR_HEART_FAMILY);
    return id;
  });
  const [look, setLook] = useState(() => ({
    value: pick(BOT_AVATAR_COLORS),
    identity: pick(ORGANIC_IDENTITIES),
  }));
  const [avatarSet, setAvatarSet] = useState<BotAvatarSet>(DEFAULT_NEW_BOT_AVATAR_SET);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function create() {
    if (isolationPending || !trimmed || submitting || (role && !businessScope)) return;
    setError(null);
    setSubmitting(true);
    const organic = avatarSet === "organic" && parseBotAvatar(look.value).shapeIndex === undefined;
    try {
      await onCreate({
        ...(role
          ? { tradingRole: role, spawnKey: previewId, tradingWorkspaceId: businessScope!.id }
          : {}),
        name: trimmed,
        color: look.value,
        ...(avatarSet === "rakazo" ? { id: previewId } : {}),
        avatarSet,
        ...(organic ? { avatarFamily: organicAvatarFamily(look.identity) } : {}),
      });
    } catch (err) {
      setError(errorText(err, t`Could not create bot`));
      setSubmitting(false);
    }
  }

  const lookPicker = (
    <BotLookPicker
      value={look.value}
      identity={avatarSet === "rakazo" ? previewId : look.identity}
      organicIdentities={ORGANIC_IDENTITIES}
      avatarSet={avatarSet}
      onAvatarSetChange={(set, value) => {
        setAvatarSet(set);
        setLook((current) => ({ ...current, value }));
      }}
      onChange={(value, identity) => {
        setLook((current) => ({ value, identity: identity ?? current.identity }));
      }}
    />
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        data-testid="create-bot-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-center">
              <Trans>New bot</Trans>
            </DialogTitle>
          </DialogHeader>
          {businessScope ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Business scope</Trans> · {businessScope.name}
            </p>
          ) : role ? (
            <div className="grid gap-2 text-sm">
              <p>
                <Trans>Select a business scope in the sidebar first.</Trans>
              </p>
              {onChooseScope ? (
                <Button type="button" variant="outline" onClick={onChooseScope}>
                  <Trans>Choose business scope</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
          {isolationPending ? (
            <p role="alert">
              <Trans>Migration required</Trans>
            </p>
          ) : null}
          <fieldset disabled={submitting || isolationPending} className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">
              <Trans>Bot template</Trans>
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(workspaceKind === "trading" ? TradingBotRoleSchema.options : []).map((value) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${role === value ? "border-primary bg-muted" : "hover:bg-muted/50"}`}
                >
                  <input
                    type="radio"
                    name="trading-template"
                    value={value}
                    checked={role === value}
                    onChange={() => {
                      if (!name.trim() || (role && name === templates[role].name))
                        setName(templates[value].name);
                      setRole(value);
                    }}
                    className="mt-1 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium">{templates[value].name}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {templates[value].description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {workspaceKind === "general" ? (
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm">
                <input
                  type="radio"
                  name="trading-template"
                  value="general"
                  checked={!role}
                  onChange={() => {
                    if (role && name === templates[role].name) setName("");
                    setRole(null);
                  }}
                  className="accent-primary"
                />
                <Trans>General bot</Trans>
              </label>
            ) : null}
          </fieldset>
          <div className="flex justify-center py-2">
            <BotAvatar
              color={look.value}
              identity={avatarSet === "rakazo" ? previewId : look.identity}
              size={role ? 48 : 96}
              avatarSet={avatarSet}
            />
          </div>
          <Input
            aria-label={t`Name`}
            placeholder={t`Name your Bot`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="text-center"
          />
          {error ? (
            <p role="alert" data-testid="create-bot-error" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          {role ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                <Trans>Appearance</Trans>
              </summary>
              <div className="mt-3">{lookPicker}</div>
            </details>
          ) : (
            lookPicker
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || submitting || Boolean(role && !businessScope)}
            >
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
