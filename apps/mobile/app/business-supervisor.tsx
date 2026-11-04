import type { RpcOutput } from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";

export default function BusinessSupervisorScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<RpcOutput<"businessSupervisor/overview"> | null>(null);
  const [error, setError] = useState("");
  useFocusEffect(
    useCallback(() => {
      let current = true;
      const load = async () => {
        try {
          const result = await rpc("businessSupervisor/overview", {});
          if (current) {
            setData(result);
            setError("");
          }
        } catch (cause) {
          if (current) setError(errorText(cause));
        }
      };
      void load();
      const timer = setInterval(() => void load(), 5000);
      return () => {
        current = false;
        clearInterval(timer);
      };
    }, []),
  );
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <SettingsGroup label={t("Business overview")}>
        <SettingsRow
          title={t("Completed tasks")}
          value={data ? `${data.completed} / ${data.total} · ${data.completionPercent}%` : "…"}
        />
        <SettingsRow title={t("Blocked")} value={String(data?.counts.blocked ?? 0)} />
        <SettingsRow title={t("Review")} value={String(data?.counts.review ?? 0)} />
        <SettingsRow title={t("Board")} chevron="right" onPress={() => router.push("/board")} />
      </SettingsGroup>
      {data?.recentTasks.map((task) => (
        <SettingsGroup key={task.id} label={`${task.ref} · ${task.title}`}>
          <SettingsRow title={task.latestComment ?? task.description ?? task.title} />
        </SettingsGroup>
      ))}
    </ScrollView>
  );
}
