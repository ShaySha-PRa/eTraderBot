import type { RpcOutput } from "@rakazo/contracts";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { formatTradingInstant, newClientId, tradingExecutionTerminal } from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useIdentityConfirmation } from "../components/confirm-identity";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

type State = RpcOutput<"trading/desk">;
export default function TradingScreen() {
  const { t, locale } = useI18n();
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const styles = useThemedStyles(createStyles);
  const insets = useSideInsets();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [desks, setDesks] = useState<RpcOutput<"trading/desks">>([]);
  const [selected, setSelected] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [learning, setLearning] = useState<RpcOutput<"trading/learningState"> | null>(null);
  const cancellationRequests = useRef(new Map<string, string>());
  const statuses = {
    accepted: t("Accepted"),
    partially_filled: t("Partially filled"),
    filled: t("Filled"),
    rejected: t("Rejected"),
    cancelled: t("Cancelled"),
    unknown: t("Result uncertain"),
  };
  const learningRequests = useRef(new Map<string, string>());
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0),
    acting = useRef(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [me, bound, available] = await Promise.all([
        rpc("me"),
        rpc("trading/desks", botId ? { botId } : {}),
        botId ? rpc("trading/desks", {}) : Promise.resolve([]),
      ]);
      if (current !== generation.current) return;
      const rows = [...bound, ...available.filter((row) => row.ownerUserId !== me.userId)];
      setUserId(me.userId);
      setDesks(rows);
      const id = rows.find((row) => row.id === selected)?.id ?? rows[0]?.id;
      const [data, learningData] = id
        ? await Promise.all([
            rpc("trading/desk", { deskId: id }),
            rpc("trading/learningState", { deskId: id }),
          ])
        : [null, null];
      if (current !== generation.current) return;
      setState(data);
      setLearning(learningData);
      setError("");
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause, t("Could not continue")));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [botId, selected, t]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const timer = setInterval(() => void load(), 10000);
      return () => {
        generation.current++;
        clearInterval(timer);
      };
    }, [load]),
  );
  async function act(action: () => Promise<unknown>) {
    if (acting.current) return;
    acting.current = true;
    setPending(true);
    try {
      await withIdentityConfirmation(action);
      await load();
    } catch (cause) {
      if (!isIdentityConfirmationRequired(cause))
        Alert.alert(t("Could not continue"), errorText(cause));
    } finally {
      acting.current = false;
      setPending(false);
    }
  }
  function confirm(title: string, action: () => Promise<unknown>) {
    Alert.alert(title, state?.desk.scope.subjectId, [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Continue"), onPress: () => void act(action) },
    ]);
  }
  const desk = state?.desk;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, insets]}>
      {loading ? <ActivityIndicator color={native.secondaryLabel} /> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {desk && botId && desk.ownerUserId !== userId ? (
        <Text style={styles.note}>
          {t("Human approval · this bot has no access to this scope")}
        </Text>
      ) : null}
      <SettingsGroup label={t("Simulation trading")}>
        {desks.map((row) => (
          <SettingsRow
            key={row.id}
            title={row.scope.subjectId}
            detail={`${row.scope.accountId} · ${row.scope.region} · ${row.scope.stage}`}
            value={desk?.id === row.id ? t("Selected") : undefined}
            onPress={() => {
              setState(null);
              setSelected(row.id);
            }}
          />
        ))}
        {!loading && !error && !desks.length ? (
          <SettingsRow
            title={t("No trading scopes")}
            detail={t("Open this Bot on web to configure its business scope.")}
          />
        ) : null}
      </SettingsGroup>
      {desk ? (
        <>
          <Text style={styles.note}>{t("Simulation only · synthetic receipts")}</Text>
          {state.versions.map((version) => (
            <SettingsGroup key={version.id} label={t("Algorithm version")}>
              <SettingsRow
                title={`${t("Margin")} ${version.parameters.margin}`}
                detail={version.artifactHash}
                value={
                  version.status === "approved"
                    ? t("Approved")
                    : version.status === "retired"
                      ? t("Retired")
                      : t("Pending")
                }
              />
              <SettingsRow
                title={t("Validation")}
                detail={
                  version.validation.kind === "learning_constraints"
                    ? t("Historical constraints checked; profit improvement is unproven")
                    : t("Deterministic constraints checked")
                }
              />
              {desk.algorithmApproverUserId === userId && version.status === "pending" ? (
                <SettingsRow
                  title={t("Approve algorithm")}
                  disabled={pending}
                  onPress={() =>
                    confirm(t("Approve algorithm"), () =>
                      rpc("trading/approveAlgorithm", {
                        deskId: desk.id,
                        versionId: version.id,
                        expectedArtifactHash: version.artifactHash,
                      }),
                    )
                  }
                />
              ) : null}
              {desk.algorithmApproverUserId === userId && version.status === "approved" ? (
                <SettingsRow
                  title={t("Retire algorithm")}
                  disabled={pending}
                  onPress={() =>
                    confirm(t("Retire algorithm"), () =>
                      rpc("trading/retireAlgorithm", { deskId: desk.id, versionId: version.id }),
                    )
                  }
                />
              ) : null}
            </SettingsGroup>
          ))}
          {state.intents.map((intent) => {
            const execution = state.executions.find((row) => row.intentId === intent.id);
            const expired = Date.parse(intent.intent.expiresAt) <= Date.now();
            return (
              <SettingsGroup key={intent.id} label={t("Trade intent")}>
                <SettingsRow
                  title={`${intent.grossNotionalCny} CNY`}
                  detail={`${intent.intent.lines.length} ${t("Orders")} · ${formatTradingInstant(intent.intent.expiresAt, locale, intent.snapshot.rules.timezone)}`}
                  value={
                    execution
                      ? statuses[execution.receipt.status]
                      : expired
                        ? t("Expired")
                        : intent.approvedAt
                          ? t("Trade approved")
                          : t("Awaiting trade approval")
                  }
                />
                {intent.intent.lines.map((line, index) => (
                  <SettingsRow
                    key={`${line.start}-${index}`}
                    title={`${line.side === "buy" ? t("Buy") : t("Sell")} ${line.energyMwh} MWh`}
                    detail={formatTradingInstant(
                      line.start,
                      locale,
                      intent.snapshot.rules.timezone,
                    )}
                    value={`${line.limitPrice} CNY/MWh`}
                  />
                ))}
                <SettingsRow
                  title={t("Source")}
                  detail={`${intent.snapshot.source.kind} · ${intent.snapshot.source.sourceId}`}
                />
                <SettingsRow title={t("Rule version")} detail={intent.intent.ruleVersion} />
                {desk.tradeApproverUserId === userId &&
                !intent.approvedAt &&
                !expired &&
                !execution ? (
                  <SettingsRow
                    title={t("Approve trade")}
                    disabled={pending}
                    onPress={() =>
                      confirm(t("Approve trade"), () =>
                        rpc("trading/approveIntent", {
                          deskId: desk.id,
                          intentId: intent.id,
                          expectedIntentHash: intent.intent.intentHash,
                        }),
                      )
                    }
                  />
                ) : null}
                {execution && !tradingExecutionTerminal(execution.receipt.status) ? (
                  <>
                    <SettingsRow
                      title={t("Reconcile order")}
                      disabled={pending}
                      onPress={() =>
                        void act(() =>
                          rpc("trading/reconcileExecution", {
                            deskId: desk.id,
                            executionId: execution.id,
                            expectedSequence: execution.receipt.sequence,
                          }),
                        )
                      }
                    />
                    {desk.tradeApproverUserId === userId ? (
                      <SettingsRow
                        title={t("Cancel order")}
                        disabled={pending}
                        onPress={() =>
                          confirm(t("Cancel order"), () => {
                            const key =
                              cancellationRequests.current.get(execution.id) ?? newClientId();
                            cancellationRequests.current.set(execution.id, key);
                            return rpc("trading/cancelSimulation", {
                              deskId: desk.id,
                              executionId: execution.id,
                              clientRequestId: key,
                            });
                          })
                        }
                      />
                    ) : null}
                  </>
                ) : null}
                {execution?.receipts.map((receipt) => (
                  <SettingsRow
                    key={receipt.sequence}
                    title={`${t("Simulation receipt")} #${receipt.sequence}`}
                    value={statuses[receipt.status]}
                    detail={`${receipt.fills.length} ${t("fills")}`}
                  />
                ))}
                {execution ? (
                  <SettingsRow
                    title={t("Simulation receipt")}
                    detail={execution.clientRequestId}
                    value={`${execution.receipt.fills.length} ${t("fills")}`}
                  />
                ) : null}
              </SettingsGroup>
            );
          })}
          {state.grants.map((grant) => (
            <SettingsGroup key={grant.id} label={t("Bounded authorization")}>
              <SettingsRow
                title={`${t("Settled")} ${grant.usedCny} / ${grant.cumulativeLimitCny} CNY`}
                detail={`${t("Reserved")} ${grant.reservedCny} CNY · ${t("Valid until")} ${formatTradingInstant(grant.expiresAt, locale)}`}
                value={grant.revokedAt ? t("Revoked") : t("Active")}
              />
              {desk.tradeApproverUserId === userId && !grant.revokedAt ? (
                <SettingsRow
                  title={t("Revoke")}
                  disabled={pending}
                  onPress={() =>
                    confirm(t("Revoke"), () =>
                      rpc("trading/revokeGrant", { deskId: desk.id, grantId: grant.id }),
                    )
                  }
                />
              ) : null}
            </SettingsGroup>
          ))}
          <SettingsGroup label={t("Learning")}>
            {learning?.plans
              .filter((plan) => !botId || plan.botId === botId)
              .map((plan) => (
                <View key={plan.id}>
                  <SettingsRow
                    title={`${plan.schedule.time} · ${plan.schedule.timezone}`}
                    value={plan.schedule.active ? t("Daily") : t("Paused")}
                    detail={
                      plan.nextRunAt
                        ? formatTradingInstant(plan.nextRunAt, locale, plan.schedule.timezone)
                        : undefined
                    }
                  />
                  {desk.ownerUserId === userId ? (
                    <SettingsRow
                      title={t("Learn now")}
                      disabled={pending}
                      onPress={() =>
                        void act(async () => {
                          const key = learningRequests.current.get(plan.id) ?? newClientId();
                          learningRequests.current.set(plan.id, key);
                          await rpc("trading/startLearning", {
                            deskId: desk.id,
                            botId: plan.botId,
                            clientRequestId: key,
                          });
                          learningRequests.current.delete(plan.id);
                        })
                      }
                    />
                  ) : null}
                </View>
              ))}
            {learning?.reports
              .filter(
                (report) =>
                  !botId ||
                  learning.sessions.some(
                    (session) => session.botId === botId && session.reportId === report.id,
                  ),
              )
              .map((report) => (
                <SettingsRow
                  key={report.id}
                  title={
                    report.outcome === "no_new_data"
                      ? t("No new material")
                      : report.outcome === "no_data"
                        ? t("No authorized material")
                        : report.validation === "constraints_passed"
                          ? t("Constraints passed · human review required")
                          : report.validation === "constraints_failed"
                            ? t("Constraints failed")
                            : t("Insufficient historical data")
                  }
                  detail={report.experience || formatTradingInstant(report.createdAt, locale)}
                />
              ))}
            {learning?.sessions
              .filter((run) => run.error && (!botId || run.botId === botId))
              .map((run) => (
                <SettingsRow
                  key={run.runId}
                  title={run.runStatus}
                  detail={run.error ?? undefined}
                />
              ))}
            <SettingsRow
              title={t("Learning settings and evidence")}
              detail={t(
                "Manage learning materials and review full reports on web. You can also change the daily plan in chat.",
              )}
            />
          </SettingsGroup>
          <Text style={styles.note}>
            {t("Manage scopes, simulation scenarios and authorizations on web.")}
          </Text>
        </>
      ) : null}
      <View style={styles.refresh}>
        <NativeActionButton
          label={t("Refresh")}
          onPress={() => void load()}
          disabled={pending}
          prominence="secondary"
        />
      </View>
      {identityDialog}
    </ScrollView>
  );
}
function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 16, paddingBottom: 40 },
    note: { color: native.secondaryLabel, fontSize: 14 },
    error: { color: mobileTokens().destructive, fontSize: 15 },
    refresh: { alignItems: "center" },
  });
}
