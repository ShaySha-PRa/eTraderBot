# eTraderBot 外部接口开发清单

这份清单可直接交给负责公司数据和交易通道的 agent。请先实现模拟适配器，再把相同契约接到真实公司系统。eTraderBot 负责 Bot、算法与学习、审批、范围授权、额度控制和审计；外部适配器提供有来源的业务数据与可核对的执行回执。

机器可读契约：[OpenAPI 3.1](eTraderBot-external-api.openapi.json)。类型及运行时验证来源：[交易契约](../../packages/contracts/src/trading.ts)。OpenAPI 由契约生成，修改字段必须同步契约，不能两边自行起不同名字。

当前交付的是外部适配器契约，尚未启动本文列出的 HTTP 服务。壳内已实现的分析 RPC 与外部适配器职责不同；实际进度见 [实施记录](../implementation/eTraderBot-v1-progress.md)。

壳内第二批已加入批准、限额授权和内部模拟回执，仍不要求外部 agent 实现本方审批。现有快照的具体拒绝项见 [样例校验记录](eTraderBot-fixture-validation.md)。

壳现在提供按业务范围配置多个 HTTP 数据 API 与 MCP 连接的入口。此处普通接口配置只保存地址、用途与加密凭据，状态为“已配置 · 未验证连通”；仍需外部适配器按下列契约完成读取、字段映射及执行联调。内部配置 API 见[业务范围与接口 API](../implementation/eTraderBot-business-workspaces-api.md)。

## 1. 接口清单与分工

示例 base URL 为 `http://localhost:8095`，地址可配置；路径中的 `/v1` 是契约版本。请求和响应使用 JSON。鉴权使用独立的 Bearer 凭据，服务端根据凭据确定允许访问的业务范围；不接收客户端自报的审批人或授权状态。

| 优先级 | 方法与路径 | 提供内容 | 建议负责方 |
| --- | --- | --- | --- |
| P0 | `GET /v1/capabilities` | 契约版本、支持的主体/环境、执行/撤单/学习资料能力 | 适配器入口 |
| P0 | `GET /v1/scopes` | 当前凭据可访问的主体、账户、资产、地区、市场与业务范围 | 业务主数据 |
| P0 | `POST /v1/snapshots/query` | 按主体和时间窗口返回决策需要的完整输入快照，含规则版本和来源 | 下表三个数据 agent |
| P1 | `POST /v1/observations/query` | 可授权读取的带教/历史记录，游标分页；保留原始来源、时间及关联快照/执行 ID | 学习数据 |
| P0（模拟）/真通道后接 | `POST /v1/executions` | 提交固定交易意图，返回接收/拒绝等明确状态；按 clientRequestId 幂等 | 执行适配器 |
| P0（模拟）/真通道后接 | `GET /v1/executions/by-request/{clientRequestId}` | 根据原请求查询状态，即使提交调用超时也能核对 | 执行适配器 |
| P1 | `POST /v1/executions/{executionId}/cancel` | 明确撤单请求及回执；不支持时 capabilities 明确表示 | 执行适配器 |

可以由三个数据 agent 分别负责以下来源，入口适配器将它们组合成统一 snapshot；同一个主体只返回对应 kind 的输入。

| 主体 | scope.subjectKind / input.kind | 需要接入的公司数据 | 必须返回的算法输入 |
| --- | --- | --- | --- |
| 售电公司 | `retailer` | 需求预测、已签合同/已承诺电量、可购买报价、可出售报价 | 每时段 forecastDemandMwh、contractedEnergyMwh、purchaseOffers、saleOffers；每个报价有 offerId、price、availableEnergyMwh |
| 发电企业 | `generator` | 可发能力、已承诺电量、分段发电成本、价格预测 | 每时段 availableEnergyMwh、committedEnergyMwh、forecastPrice、segments；每段有 segmentId、energyMwh、marginalCost |
| 独立储能 | `storage` | 储能容量、当前电量、上下限、终端保有电量、充放电功率/效率、退化成本、价格预测 | capacityMwh、initialEnergyMwh、minEnergyMwh、maxEnergyMwh、terminalMinEnergyMwh、maxChargeMw、maxDischargeMw、chargeEfficiency、dischargeEfficiency、degradationCostPerMwh；每时段 forecastPrice |

这是一版对接契约，尚未等同于真实公司字段字典。若现有系统只有 SOC，请在适配器将其按同一容量口径换算为 MWh，并保留来源。无法取得的必填字段应返回明确错误，不能用零或模型估值伪装已取得的数据。

## 2. 公共字段与语义

- `scope`：subjectId、subjectKind、accountId、可选 assetId、region、marketId、productId、stage、environment。储能快照必须有 assetId。region 使用 CN-SH / CN-JS / CN-SD；stage 使用 mid_long_term / day_ahead / intraday / realtime。市场与产品 ID 来自实际配置，不能按地区名称推断参与资格。
- `environment`：simulation 或 live，表示运行环境，与资料来源分别记录。模拟可以使用合成数据、已授权公司数据或有来源的公开历史资料；合成数据必须标 synthetic，公开历史资料可标 user，不得因为用于模拟就改写其真实来源。真实请求不得回落到合成资料。模拟执行回执仍必须标 synthetic。
- `source`：sourceId、kind、observedAt、asOf、validUntil、revision。kind 为 synthetic / company / user。asOf 是信息已经可用的时刻，不得把未来实际结果塞进历史预测；observedAt 是采集时间。revision 变化表示源内容发生变化。
- 时间使用带 UTC 偏移的 ISO 8601；区间均为 `[start, end)`，按开始时间升序、连续、不重复。source.asOf ≤ source.observedAt < source.validUntil。
- 金额/电量/功率等传十进制字符串，最多 6 位小数、最多 12 位整数，禁止指数、NaN、Infinity、单位后缀和浮点 JSON 数值。价格 CNY/MWh，电量 MWh，功率 MW，效率为 `(0,1]` 的比例。市场允许时价格可为负值。
- `rules`：id/version、来源、verification、有效区间、IANA timezone、币种 CNY、时段分钟数、价格上下限、报价步长、电量步长、最大快照年龄。步长必须为正，价格下限不大于上限。synthetic / verified / unverified 的状态必须如实填写；真实规则的启用仍由 eTraderBot 核验。
- `snapshotId` 一经发布对应不可变内容；同一 ID 不得覆盖改写，订正须新 ID 与 revision。scope.subjectKind 与 input.kind 必须一致，规则、范围和数据窗口必须匹配。
- 售电报价 ID 在一个时段内唯一；报价可用电量非负。发电已承诺电量不得超过可发能力，分段成本覆盖可发电量。储能满足 `0 ≤ min ≤ initial ≤ max ≤ capacity`、`min ≤ terminalMin ≤ max`，功率为正，效率在合法范围。
- JSON Schema 描述形状；上述跨字段、时序、访问范围和不可变性约束也必须实现，不能只验证字段类型。

## 3. 执行及幂等

- eTraderBot 完成人类批准、风控与额度占用之后调用执行接口。适配器不能替 Bot 签发批准，也不能绕过本方交易系统原有的权限和业务检查。
- `POST /v1/executions` 传 clientRequestId 和固定 intent。intent 含 intentId、intentHash、scope、algorithmVersionId、snapshotId、ruleVersion、expiresAt 及每条时段/方向/电量/限价。
- 同一凭据与环境下的 clientRequestId 对应一次提交；相同请求重试返回同一 executionId，内容不同返回 409/IDEMPOTENCY_CONFLICT。必须先持久化幂等记录再发送外部请求。
- 查询端点必须能恢复“提交响应丢失”的结果；不存在返回 404/NOT_FOUND，结果不确定返回 status=unknown。unknown 不等于 rejected，不得据此直接再次下单。
- receipt 保留 clientRequestId、intentHash、scope、source、单调递增 sequence 和稳定 fillId。fills 为累计成交列表，每条关联原 lineIndex；不得在重试时复制成交。重复回执不增加累计成交，部分成交后的撤单继续保留已成交记录。
- accepted 表示被接受，不表示成交；filled / rejected / cancelled 必须有对应模拟或外部回执依据。模拟 receipt.source.kind 必须为 synthetic。
- 撤单 clientRequestId 是撤单自身的幂等键，不能覆盖原申报键；返回的 receipt.clientRequestId 仍是原申报键，便于继续按原请求查询。

## 4. 学习资料

`observations/query` 根据 scope 和 `[from,to)` 返回授权范围内记录。kind 为 chat、file、operation、history。content 是已授权文本或可解释的结构化记录文本，关联 snapshotIds/executionIds；不得夹带连接密钥或凭据。文件可先完成解析后作为 file 记录返回。

游标分页需要固定该次查询的读取范围，记录 ID 稳定、不漏不重；结束时 nextCursor=null。这个接口提供可读取资料，不负责算法生成、模型训练、版本启用或跨主体共享审批。

## 5. 错误与交付验收

统一错误体包含 code、message、requestId、retryable。HTTP 对应：400 INVALID_INPUT，401 UNAUTHORIZED，403 FORBIDDEN，404 NOT_FOUND，409 IDEMPOTENCY_CONFLICT，422 STALE_DATA / RULES_UNVERIFIED，429 RATE_LIMITED，503 NOT_CONFIGURED / UNAVAILABLE。业务拒单可返回 200 + receipt.status=rejected；通信失败不能冒充业务拒单。

每个外部 agent 应交付：

1. 可启动的模拟服务，遵循这份 OpenAPI；启动和配置说明，不包含真实密钥。
2. 对应主体的最小可用样例，明确 synthetic，固定数据可重复；可按查询窗口生成一致时段。
3. 数据来源、单位、口径与公司字段映射说明；拿不到的字段写明缺口。
4. 鉴权和跨主体隔离验证；未授权请求不得泄露其他账户的存在和内容。
5. 缺字段、旧快照、未核实规则、空数据、接口故障的错误样例。
6. 执行 agent 额外交付重复提交、内容冲突、超时后查询、部分成交及撤单的契约测试。

无需修改 eTraderBot 的壳、数据库审批表、算法版本库或内部限额。对接先完成 simulation；启用 live 要在真实规则、公司权限与联调验收完成后进行。

## 6. 样例自检

快照 JSON 放在 `snapshots/retailer`、`snapshots/generator`、`snapshots/storage` 对应目录，查询样例使用 `.query.json`，来源旁路说明使用 `.provenance.json`。在仓库根运行：

```bash
pnpm exec tsx packages/core/scripts/validate-trading-fixtures.ts docs/integration/fixtures/snapshots
```

校验以数据与规则均已被观察到的最早时刻重放，保留原资料，不重写时间或来源；存在失败时退出码为 1。JSON 结构通过不代表可计算：数据与规则必须有重叠的有效期，成本段必须覆盖可发能力，可执行买卖报价须符合规则步长。价格预测可保留估计精度，储能基线生成报价时按方向取保守合法步长。公开历史资料的来源真实性与是否含未来信息仍需提供方另外核实。

## 天气预测扩展

已增加独立于交易快照的天气数据接入，支持主动拉取与外部推送；公司内部模型的输出由本地确定性模拟服务替代。见[天气接入说明](./eTraderBot-weather-api.md)、[天气 OpenAPI](./eTraderBot-weather-api.openapi.json)及[合成预测样例](./fixtures/weather-forecast.synthetic.json)。天气不会自动变为负荷、出力或交易信号。
