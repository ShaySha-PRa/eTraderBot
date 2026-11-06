import type { BusinessCycleState, RpcOutput } from "@rakazo/contracts";
import { latestBusinessEvidence } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";

export default function BusinessCycleScreen() {
  const { t } = useI18n();
  const [cycles, setCycles] = useState<RpcOutput<"businessCycle/list">>([]);
  const [selected, setSelected] = useState("");
  const [state, setState] = useState<BusinessCycleState | null>(null);
  const [error, setError] = useState("");
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        try {
          const rows = await rpc("businessCycle/list", {});
          const id = rows.find((r) => r.id === selected)?.id ?? rows[0]?.id;
          const next = id ? await rpc("businessCycle/get", { cycleId: id }) : null;
          if (active) {
            setCycles(rows);
            setState(next);
            setError("");
          }
        } catch (cause) {
          if (active) setError(errorText(cause));
        }
      };
      void load();
      const timer = setInterval(() => void load(), 5000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [selected]),
  );
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <SettingsGroup label={t("Business cycle")}>
        <SettingsRow title={t("Teaching simulation; energy settlement is not net profit.")} />
        <SettingsRow
          title={t(
            "Import simulation data and approve trades on Web. Chat uses the same evidence and permission checks.",
          )}
        />
        {cycles.map((c) => (
          <SettingsRow
            key={c.id}
            title={c.name}
            value={c.id === state?.cycle.id ? "✓" : ""}
            onPress={() => setSelected(c.id)}
          />
        ))}
      </SettingsGroup>
      {state ? (
        <>
          <SettingsGroup label={t("Market rules and windows")}>
            <SettingsRow title={state.cycle.rule.version} value={state.cycle.rule.source} />
            {state.cycle.rule.stages.map((r) => (
              <SettingsRow key={r.stage} title={`${r.stage} · ${r.mode}`} value={r.closesAt} />
            ))}
          </SettingsGroup>
          {latestBusinessEvidence(state.evidence).map((e) => (
            <SettingsGroup key={e.id} label={`${e.streamKey} · v${e.revision} · ${e.status}`}>
              <SettingsRow title={`${e.origin} · ${e.source}`} value={e.sourceRecordId} />
              <SettingsRow title={JSON.stringify(e.data, null, 2)} />
              <SettingsRow title={t("References")} value={e.references.join(", ") || "—"} />
            </SettingsGroup>
          ))}
          <SettingsGroup label={t("Energy settlement")}>
            <SettingsRow
              title={t("Energy settlement")}
              value={
                state.settlement
                  ? `${state.settlement.energyAmountCny} CNY`
                  : t("Waiting for evidence")
              }
            />
            <SettingsRow
              title={t("Equivalent difference form")}
              value={state.settlement?.equivalentDifferenceCny ?? "—"}
            />
            <SettingsRow title={t("Net profit")} value={t("Not established")} />
            <SettingsRow title={t("Blocked")} value={state.blockers.join(", ") || "—"} />
          </SettingsGroup>
          {state.tasks.map((task) => (
            <SettingsGroup
              key={task.ticketId}
              label={`${task.ref} · ${task.kind} · ${task.status}`}
            >
              <SettingsRow title={t("Blocked")} value={task.blockers.join(", ") || "—"} />
              {task.result ? (
                <>
                  <SettingsRow title={task.result.summary} />
                  <SettingsRow
                    title={t("Unresolved")}
                    value={task.result.unresolved.join("; ") || "—"}
                  />
                  <SettingsRow
                    title={t("Disagreements")}
                    value={task.result.disagreements.join("; ") || "—"}
                  />
                </>
              ) : null}
            </SettingsGroup>
          ))}
          <SettingsGroup label={t("Evidence history")}>
            {state.evidence.map((e) => (
              <SettingsRow
                key={e.id}
                title={`${e.streamKey} · v${e.revision}`}
                value={`${e.id} · ${e.supersedesId ?? e.sourceRecordId}`}
              />
            ))}
          </SettingsGroup>
        </>
      ) : null}
    </ScrollView>
  );
}
