import { Trans, useLingui } from "@lingui/react/macro";
import type { TradingInterface } from "@rakazo/contracts";
import { WEATHER_PUSH_PATH } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useTradingActions } from "../lib/trading-actions";
import { errorText } from "../lib/user-error";

export function WeatherInterface({ entry }: { entry: TradingInterface }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const input = { workspaceId: entry.workspaceId, interfaceId: entry.id };
  const records = useQuery({
    ...queries.trading.weatherForecasts.queryOptions({ input: { ...input, limit: 5 } }),
    refetchInterval: 60_000,
  });
  const { api, act, error, pending, identityDialog } = useTradingActions();
  const [token, setToken] = useState("");
  const [receipt, setReceipt] = useState("");
  const latest = records.data?.[0];
  const date = (value: string) => new Date(value).toLocaleString(i18n.locale);
  const path = WEATHER_PUSH_PATH.replace(":interfaceId", encodeURIComponent(entry.id));
  return (
    <div className="grid gap-3" data-testid="weather-interface">
      {entry.config.transport === "http" ? (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            void act(async () => {
              const result = await api.trading.pullWeather(input);
              setReceipt(
                result.duplicate ? t`This forecast was already received` : t`Forecast received`,
              );
            })
          }
        >
          <Trans>Pull forecast</Trans>
        </Button>
      ) : null}
      {receipt ? (
        <p role="status" className="text-sm">
          {receipt}
        </p>
      ) : null}
      {error || records.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error || errorText(records.error)}
        </p>
      ) : null}
      {latest ? (
        <div className="grid gap-2 text-sm">
          <p>
            {latest.forecast.location.name} · {latest.forecast.location.region} ·{" "}
            {latest.forecast.source.kind === "synthetic"
              ? t`Simulated data`
              : latest.forecast.source.kind === "company"
                ? t`Company data`
                : t`User data`}{" "}
            · {latest.fresh ? t`Current forecast` : t`Expired forecast`}
          </p>
          <p className="text-muted-foreground">
            <Trans>Issued</Trans>: {date(latest.forecast.issuedAt)} · <Trans>Valid until</Trans>:{" "}
            {date(latest.forecast.validUntil)}
          </p>
          <details>
            <summary className="cursor-pointer">
              <Trans>Forecast details</Trans>
            </summary>
            <p className="my-2 text-muted-foreground">
              {latest.forecast.source.modelVersion} · <Trans>Received</Trans>:{" "}
              {date(latest.receivedAt)} · {latest.transport === "pull" ? t`Pulled` : t`Pushed`}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-xs">
                <caption className="py-2 text-left">{latest.forecast.location.timezone}</caption>
                <thead>
                  <tr>
                    {[
                      t`Period`,
                      t`Temperature (°C)`,
                      t`Wind (m/s)`,
                      t`Humidity (%)`,
                      t`Rain (mm)`,
                      t`Solar (W/m²)`,
                      t`Cloud (%)`,
                    ].map((label) => (
                      <th key={label} className="p-2 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {latest.forecast.periods.map((period) => (
                    <tr key={period.start} className="border-t">
                      <td className="p-2">
                        {new Date(period.start).toLocaleString(i18n.locale, {
                          timeZone: latest.forecast.location.timezone,
                        })}{" "}
                        –{" "}
                        {new Date(period.end).toLocaleTimeString(i18n.locale, {
                          timeZone: latest.forecast.location.timezone,
                        })}
                      </td>
                      {[
                        period.temperatureC,
                        period.windSpeedMps,
                        period.relativeHumidityPct,
                        period.precipitationMm,
                        period.solarIrradianceWm2,
                        period.cloudCoverPct,
                      ].map((value, index) => (
                        <td key={index} className="p-2">
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 break-all text-muted-foreground">
              <Trans>Batch</Trans>: {latest.forecast.batchId}
            </p>
          </details>
          {(records.data?.length ?? 0) > 1 ? (
            <details>
              <summary className="cursor-pointer">
                <Trans>Recent forecasts</Trans>
              </summary>
              {records.data?.map((row) => (
                <p key={row.id} className="mt-1 break-all">
                  {date(row.forecast.issuedAt)} · {row.forecast.batchId}
                </p>
              ))}
            </details>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {records.isPending ? t`Loading…` : t`No weather forecast received`}
        </p>
      )}
      {entry.config.transport !== "mcp" ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>External push</Trans>
          </summary>
          <div className="mt-3 grid gap-3 text-sm">
            <p className="break-all">POST {path}</p>
            <p className="text-muted-foreground">
              <Trans>Send the forecast JSON with an Authorization: Bearer token header.</Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    setToken("");
                    const result = await api.trading.rotateWeatherPushToken(input);
                    setToken(result.token);
                  }, true)
                }
              >
                {entry.hasPushToken ? t`Replace push token` : t`Create push token`}
              </Button>
              {entry.hasPushToken ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      await api.trading.revokeWeatherPushToken(input);
                      setToken("");
                    }, true)
                  }
                >
                  <Trans>Revoke push token</Trans>
                </Button>
              ) : null}
            </div>
            {token ? (
              <div className="grid gap-2">
                <label htmlFor={`weather-token-${entry.id}`}>
                  <Trans>Push token — shown once</Trans>
                  <Input
                    className="mt-1"
                    id={`weather-token-${entry.id}`}
                    type="password"
                    autoComplete="off"
                    readOnly
                    value={token}
                  />
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void act(() => navigator.clipboard.writeText(token))}
                >
                  <Trans>Copy push token</Trans>
                </Button>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {identityDialog}
    </div>
  );
}
