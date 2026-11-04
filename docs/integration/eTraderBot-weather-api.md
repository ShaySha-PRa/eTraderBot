# 天气预测数据接入

模拟公司内部天气预测大模型的**接口与输出**，支持 eTraderBot 主动拉取和外部系统主动推送。当前模拟器使用确定性曲线生成逐小时数据，不运行气象神经网络、不使用真实观测，不代表真实预测准确率。后续公司服务只需实现相同数据契约即可替换。

- 契约：[trading-weather.ts](../../packages/contracts/src/trading-weather.ts)
- [OpenAPI](./eTraderBot-weather-api.openapi.json) · [合成样例](./fixtures/weather-forecast.synthetic.json)
- OpenAPI 重新导出：`pnpm exec tsx packages/contracts/scripts/export-trading-api.ts`

## 本地拉取

1. 从仓库根目录执行 `pnpm weather:simulator`，默认只监听 `127.0.0.1:8096`。
2. API 访问本机或内网服务需在部署环境设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true` 后重启。它是既有的全部署私网访问策略，也影响其他远程连接；默认关闭，不针对某个账户绕过。公开端点要求 HTTPS，元数据地址和重定向仍被拒绝。
3. 在业务范围 → 接口设置 → 添加接口中选择用途 **天气预测**、类型 **HTTP API**，点击 **使用本地天气模拟服务**，保存后点击 **拉取预测**。按钮填入当前业务地区；也可手动配置地址、GET/POST、查询参数、请求体和凭据。
4. 预测卡片显示签发时间、有效期、来源、地点、逐小时指标及接收记录。拉取失败明确报错，不自动回落合成数据。当前按用户操作拉取；没有默认轮询任务。

模拟器读取接口：

```bash
curl --fail 'http://127.0.0.1:8096/v1/weather/forecast?region=CN-SH&hours=24'
```

`region` 支持 `CN-SH`、`CN-JS`、`CN-SD`；`hours` 为 1–168，默认 24。同一地区、预测长度和签发小时产生同一批次。可用 `WEATHER_SIMULATOR_PORT` 改端口、`WEATHER_SIMULATOR_REGION` 改默认地区。模拟服务的读取接口无认证且只绑定回环地址；公司真实服务使用已有 HTTP 凭据配置。

## 外部推送

用途选择 **天气预测**，连接类型可选择 **外部推送**；HTTP 天气接口也能接收推送。展开卡片的 **外部推送**，创建推送令牌。令牌仅显示一次，数据库只存摘要。更换和撤销后旧令牌立即失效；它只能发布到对应接口所属业务范围，不具有交易或其他 API 权限。

外部服务发送 `POST /api/v1/trading/weather/{interfaceId}`，请求头：`Content-Type: application/json`、`Authorization: Bearer <令牌>`，请求体为一份完整预测。使用页面显示的路径和可到达 API 的基础地址，开发默认 API 端口为 3100。

模拟公司服务推送一次（先将目标地址和令牌安全地注入环境，不把真实令牌写入脚本或仓库）：

```bash
# WEATHER_PUSH_URL 与 WEATHER_PUSH_TOKEN 已由调用环境提供
WEATHER_SIMULATOR_REGION=CN-SH pnpm weather:simulator --push
```

推送返回 `{id,batchId,duplicate,receivedAt}`。同一接口下同一 `batchId`、内容相同返回原始记录，`duplicate=true`；内容不同返回 409，订正必须使用新批次 ID。推送最多 256 KiB。HTTP 拉取同样限制响应大小，并在 15 秒内超时。

## 字段和时间

| 字段 | 语义 |
| --- | --- |
| `schemaVersion` | 当前为字符串 `1` |
| `batchId` | 源系统发布的不可变批次标识，接口内唯一 |
| `source` | `sourceId`、`kind=synthetic/company/user`、`modelVersion`；模拟器固定 `synthetic` |
| `issuedAt` / `validUntil` | 带时区 ISO 时间；新批次必须已经签发且当前仍有效。不得将采集时间伪装为签发时间 |
| `location` | `siteId`、`name`、`region`、IANA `timezone`；地点必须明确，后端不会据此自动推断电厂或资产映射 |
| `periods` | 1–168 个按时间排序、不重叠的 `[start,end)` 时段，开始不得早于签发时间 |
| 时段指标 | `temperatureC`（℃）、`windSpeedMps`（m/s）、`relativeHumidityPct`（%）、`precipitationMm`（该时段 mm）、`solarIrradianceWm2`（该时段平均 W/m²）、`cloudCoverPct`（%） |

指标均为十进制字符串，最多 6 位小数。除气温可负外均非负，两种百分比不超过 100；缺字段、混用单位、额外字段或 JSON 数值均拒绝。OpenAPI 不能完整表达的时间、时区和数值约束由服务端共享校验执行。

`receivedAt` 由本服务生成，与源签发时间分别保存。过期记录保留并标记 `fresh=false`。列表按签发时间降序，迟到的旧批次不会覆盖更新预测；已接收批次即使过期，完全相同的重试仍返回原记录。固定日期样例用于契约校验，不能当作当前有效预测直接推送；联调用运行中的模拟器生成新数据。

## 范围、权限与 Bot

| 认证 RPC | 说明 |
| --- | --- |
| `trading/weatherForecasts` | `{workspaceId,interfaceId?,siteId?,limit:1..20}`；业务所有者或指定审批人可读 |
| `trading/pullWeather` | `{workspaceId,interfaceId}`；所有者从保存的 HTTP 配置拉取并持久化 |
| `trading/rotateWeatherPushToken` | 同上；所有者经身份确认创建／轮换令牌 |
| `trading/revokeWeatherPushToken` | 同上；所有者经身份确认撤销令牌 |

Bot 调用 `trading` 工具的 `{operation:"weather",deskId,siteId?}` 查询所属业务最近一份预测；先用 `scopes` 获取已绑定场景。工具没有拉取、创建令牌或跨范围读取权限。该工具跨 Web、Electron 和原生聊天共用；接口管理和天气表格当前在 Web/Electron 完成。不同业务数据与凭据按 Space 隔离，删除接口保留已接收预测及来源名称，切换用途或连接为 MCP 会撤销天气推送令牌。

天气信息当前供查询与解释，**不自动转换成电力预测、交易参数或算法学习输入**。每日学习的授权资料与人审边界保持不变；从天气到负荷／新能源出力的映射、真实模型准确率与策略效果须另行验证。MCP 连接仍可按已有工具授权使用，暂不自动转成此 HTTP 天气契约。
