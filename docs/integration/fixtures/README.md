# eTraderBot 外部接口 fixtures（simulation / synthetic）

对齐契约：

- [`../eTraderBot-interface-list.md`](../eTraderBot-interface-list.md)
- [`../eTraderBot-external-api.openapi.json`](../eTraderBot-external-api.openapi.json)
- [`../../../packages/contracts/src/trading.ts`](../../../packages/contracts/src/trading.ts)

**环境**：全部 `environment=simulation`，数据 `source.kind=synthetic`。\
**禁止**：把这里的数字当成公司内部数或未核实的现行省规则参数。

## 目录索引

| 路径 | 对应 OpenAPI | 说明 |
| --- | --- | --- |
| `capabilities/capabilities.simulation.json` | `GET /v1/capabilities` | 仅 simulation；执行/撤单/observations 均支持 |
| `scopes/scopes.simulation.json` | `GET /v1/scopes` | 9 个主体：售电×3、发电×3、储能×3；区域 CN-SH/JS/SD；多 stage |
| `snapshots/retailer/*.json` | `POST /v1/snapshots/query` 响应 | 每主体多交易日；旁路 `*.query.json` 为请求体 |
| `snapshots/generator/*.json` | 同上 | 风电/煤电/光伏形状；分段成本 |
| `snapshots/storage/*.json` | 同上 | 含 assetId；SOC 类字段已用 MWh 口径 |
| `snapshots/index.json` | — | 快照清单 |
| `observations/observations.page1.json` | `POST /v1/observations/query` | 游标第一页 + `nextCursor` |
| `observations/observations.page2.json` | 同上 | `nextCursor=null` |
| `observations/observations.query.json` | 请求体样例 | |
| `executions/submit.*.request.json` | `POST /v1/executions` 请求 | |
| `executions/submit.*.response.json` | 提交响应 / 409 错误体 | |
| `executions/by-request.*.json` | `GET /v1/executions/by-request/{id}` | 含 filled / unknown→resolved / partial / 404 |
| `executions/cancel.*.json` | `POST /v1/executions/{id}/cancel` | 部分成交后撤单；fills 保留；receipt.clientRequestId=原申报键 |
| `executions/index.json` | — | 用例索引 |
| `public-sources/SOURCES.json` | — | 公开披露来源尝试记录与映射口径 |

## 如何对照 OpenAPI / trading.ts

1. 响应形状以 `trading.ts` 的 `Trading*Schema` 为准（OpenAPI 由其生成）。\
2. 金额/电量/功率均为**十进制字符串**（禁止 JSON number）。\
3. 时间带 UTC 偏移；窗口 `[start,end)`；`asOf ≤ observedAt < validUntil`。\
4. 储能满足 `0 ≤ min ≤ initial ≤ max ≤ capacity` 且 `min ≤ terminalMin ≤ max`。\
5. 执行幂等：相同 `clientRequestId`+相同 intent → 同一 `executionId`；意图变更 → `IDEMPOTENCY_CONFLICT`。\
6. `status=unknown` **不等于** rejected，不得据此盲着重提。\
7. 模拟回执 `source.kind` 必须为 `synthetic`。

## 公开数据说明

优先查找国内现货公开披露后的结论见 `public-sources/SOURCES.json`：

- 辽宁发改委现货电价公示专区有网页入口，但本轮**未获得**可批量、许可清晰的机读序列，故**未写入** snapshot。\
- 政策类链接只作制度背景。\
- 第三方聚合平台未接入。\
- 文件中的 `forecastPrice` / 报价曲线均为 **synthetic 教学形状**（昼夜峰谷示意），**不是**某省某日官方出清。

若后续人工从公开网页抄录价格：可放进 `forecastPrice`，并在旁路笔记中写 URL+日期；`source.kind` 用 `synthetic` 或 `user`（仍**不要**标 `company`）。

## 生成信息

- 生成日：2026-11-03（America/Los_Angeles）\
- 教学交易日窗口：2025-03-10 … 2025-03-12（Asia/Shanghai）\
- 未改 rakazo 壳代码；不含密钥。


## 公开现货电价（辽宁统一结算点）

已从省发改委通知公告附件 PDF 抄录 **2025-03-10 / 03-11 / 03-12** 统一结算点 **日前 + 实时** 15 分钟序列：

- 旁路表：`public-sources/liaoning-unified-settlement/`
- 单位：PDF 为「元/千千瓦时」= **CNY/MWh**
- 写入 snapshot：`forecastPrice`（发电/储能）= 日前电价小时算术平均；售电首档 `purchaseOffers[0].price` 同口径（售出价 = DA+15 为合成价差，已在 provenance 标明）
- `source.kind` = **`user`**（禁止 `company`）
- 契约 `region` 枚举无辽宁：现有 scope 仍为 CN-SH/JS/SD 模拟主体，**价格仅为辽宁公开序列叠加，不表示该省/主体官方出清**

原始 PDF URL 与摘录见该目录 `manifest.json` 与 `*.extract.txt`。


## Synthetic batch2 增量

- 新主体：`ret-sh-02`、`ret-sd-02`、`gen-sd-coal-02`、`gen-js-wind-02`、`sto-sd-bess-04`、`sto-sh-bess-05`
- 新交易日：2025-03-20 … 03-24（+ 03-25 负电价储能压力样例）
- 新 observations：`observations.batch2.json`
- 新执行异常：限流/不可用/未配置/陈旧快照/规则未核实/鉴权失败/非法输入；多笔部分成交后撤单；仅 accepted 未成交
- 全部 `environment=simulation` 且本批 `source.kind=synthetic`（不覆盖辽宁 `user` 抄录日）
