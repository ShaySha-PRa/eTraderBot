import type { TradingBotRole, TradingWorkspace } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { cancelHeaderOptions } from "../components/sheet-header";
import { rpc } from "../lib/api";
import { createInboxBot } from "../lib/create-inbox-bot";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function NewBot() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const insets = useSideInsets();
  const [kind, setKind] = useState<"general" | "trading">();
  const [isolationPending, setIsolationPending] = useState(false);
  const [scopes, setScopes] = useState<TradingWorkspace[]>([]);
  const workspaceId = scopes[0]?.id ?? "";
  const [businessName, setBusinessName] = useState("");
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void Promise.all([rpc("trading/workspaces", {}), rpc("spaces/list", {})])
        .then(([rows, navigation]) => {
          if (alive) {
            setScopes(rows);
            setKind(navigation.current.kind);
            setIsolationPending(navigation.current.isolationPending);
            setRole(navigation.current.kind === "trading" ? "spot" : undefined);
            setBusinessName(
              navigation.current.name === "Personal"
                ? t("Default business scope")
                : navigation.current.name,
            );
          }
        })
        .catch((cause) => {
          if (alive) setError(errorText(cause));
        });
      return () => {
        alive = false;
      };
    }, [t]),
  );
  const [role, setRole] = useState<TradingBotRole>();
  const [name, setName] = useState("");
  const [spawnKey] = useState(newClientId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const templates = [
    { role: "mid_long_term", name: t("Mid / long term bot") },
    { role: "spot", name: t("Spot bot") },
    { role: "risk", name: t("Risk bot") },
    { role: "review", name: t("Review bot") },
    { role: undefined, name: t("General bot") },
  ] as const;
  async function create() {
    if (!kind || isolationPending || pending || !name.trim() || (role && !workspaceId)) return;
    setPending(true);
    setError("");
    try {
      await createInboxBot({
        template: {
          name: name.trim(),
          tradingRole: role,
          tradingWorkspaceId: role ? workspaceId : undefined,
          spawnKey,
        },
        refreshBots: async () => undefined,
        openChat: (href) => router.replace(href),
      });
    } catch (cause) {
      setError(errorText(cause, t("Could not create bot")));
      setPending(false);
    }
  }
  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t("Cancel"), () => router.back())} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={[{ flex: 1, backgroundColor: tokens.background }, insets]}
        contentContainerStyle={{ padding: 24, gap: 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <SettingsGroup label={t("Business scope")}>
          <SettingsRow title={businessName || t("Business scope")} />
        </SettingsGroup>
        {kind === "trading" && !workspaceId ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {t(
              "Configure this business scope and its data APIs on the web before creating trading bots.",
            )}
          </Text>
        ) : null}
        {isolationPending ? <Text accessibilityRole="alert">{t("Migration required")}</Text> : null}
        <SettingsGroup label={t("Bot template")}>
          {templates
            .filter((template) => (kind === "trading" ? Boolean(template.role) : !template.role))
            .map((template) => (
              <SettingsRow
                key={template.role ?? "general"}
                title={template.name}
                value={role === template.role ? t("Selected") : undefined}
                disabled={pending}
                onPress={() => {
                  if (!name || templates.some((item) => item.name === name)) setName(template.name);
                  setRole(template.role);
                }}
              />
            ))}
        </SettingsGroup>
        <TextInput
          accessibilityLabel={t("Name")}
          placeholder={t("Name")}
          placeholderTextColor={tokens.mutedForeground}
          value={name}
          onChangeText={setName}
          editable={!pending}
          maxLength={BOT_NAME_MAX_LENGTH}
          style={{
            padding: 14,
            borderRadius: 11,
            backgroundColor: native.fill,
            color: tokens.foreground,
            fontSize: 16,
          }}
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
        <NativeActionButton
          label={t("Create")}
          disabled={
            !kind || isolationPending || pending || !name.trim() || Boolean(role && !workspaceId)
          }
          onPress={() => void create()}
        />
      </ScrollView>
    </>
  );
}
