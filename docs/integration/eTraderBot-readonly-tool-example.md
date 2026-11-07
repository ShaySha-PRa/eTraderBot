# 标准只读工具接入样例

本例用**合成负荷预测**演示配置 → 指定 Bot 授权 → 标准 MCP 调用 → 来源与失败反馈。仅有两个虚构小时的预测，固定日期 `2026-11-08`、版本 `synthetic-load-v1`；没有真实模型、真实公司数据、计量或结算结论。服务不连接 Rakazo 数据库、不写业务证据、不提供交易操作。

## 实现位置与接入边界

- 共享校验及结果类型：[readonly-source.ts](../../packages/contracts/src/readonly-source.ts)。
- 源与标准 MCP 服务：[readonly-source.ts](../../packages/adapters/src/examples/readonly-source.ts)。使用仓库已有 SDK 和有边界的 HTTP 读取，不下载或执行外部插件。
- 可直接启动的入口：[readonly-source-example.ts](../../packages/adapters/src/cli/readonly-source-example.ts)。
- Rakazo 原有 `mcp.servers` / `mcp.assignments` RPC、McpConnector、密钥存储、执行器、Task/Run、审批及工具结果消息保持原架构，不增加 RPC 或新调度器。

一个 MCP 源固定一个工作区 **Space ID**，不是 TradingWorkspace ID。执行器从已持久化 Run 取得 workspace/user/Bot，重查其有效性；MCP 调用再检查当前源范围、启用状态、Bot 分配和工具白名单。模型不能在查询参数中选择工作区、执行身份、目标 URL 或凭据。

外部服务通过自己配置的凭据保护固定数据范围，并不从模型参数判断身份。本地示例需要操作者将 `workspaceId` 和连接登记的业务对应起来；它不是生产多租户认证服务器。不要把一个业务的源与凭据复制给另一业务来冒充隔离授权。

## 启动与配置

先准备**独立验收数据库与应用数据目录**，依照当前启动保护流程启动测试应用。不要运行隐式选库脚本覆盖已有 Desktop 服务。以下示例命令只启动数据源，工作目录为当前仓库根，不加载 `.env` 或修改应用库。

在临时目录创建配置文件（文件权限建议 `0600`；内容全是模拟值）：

```json
{
  "workspaceId": "REPLACE_WITH_TEST_BUSINESS_SPACE_ID",
  "credential": "synthetic-readonly-example-token",
  "port": 8098,
  "sourcePort": 8099,
  "timeoutMs": 2000
}
```

`credential` 必须以 `synthetic-` 开头。勿填真实密钥；两端复用此模拟 token，仅为降低样例配置成本。CLI 不打印 token。8098/8099 必须空闲，或在配置文件中更换；服务只监听 `127.0.0.1`。

```sh
pnpm exec tsx packages/adapters/src/cli/readonly-source-example.ts --config /tmp/readonly-example.json
```

输出两条地址：HTTP 源 `http://127.0.0.1:8099/forecast`、MCP `http://127.0.0.1:8098/mcp`。默认一起启动；Ctrl+C 仅停止这个进程拥有的服务。分开演示断连时，在两个终端分别加 `--component source` 和 `--component mcp`；后者可在配置里设置固定 `sourceUrl`，但仅接受无凭据、无查询参数的 `http://127.0.0.1/...` URL。

Rakazo API / worker 必须能访问上述地址。若在不同容器 / 主机内，`127.0.0.1` 指的是各自进程环境，本样例不自动建立转发或开放公网。独立验收应用需要按既有配置允许本地 MCP：`MCP_ALLOW_PRIVATE_ENDPOINT=true`；不要为样例改生产网络策略。

在当前业务的既有 MCP 连接页面或同身份 RPC 中：

1. `mcp.servers.create`：`slug:"readonly-example"`，名称 `Synthetic readonly example`，`transport:"streamable_http"`，endpoint 如上，`headers:{}`，secret 使用配置中的模拟 token，**`enabled:false`**。
2. `mcp.servers.agents({id,allBots:false,botIds:[目标BotID]})`。不要使用默认全 Bot 授权。
3. `mcp.assignments.replace({botId,assignments:[{serverId,allowAllTools:false,allowedTools:["read_synthetic_load"]}]})`。该接口替换该 Bot 的全部 MCP 分配；若它已有其他连接，先 list 并将原分配一起提交，不能为本例删除别人的连接。
4. `mcp.servers.update({id,config:{slug,name,transport,endpoint,headers:{},enabled:true}})`。更新时省略 secret 保留既有密钥；不从服务端读回明文。`mcp.servers.test({id})` 只验证连接与工具发现，不等于已完成查询或授予交易权。

API 请求用现有登录会话和正确的 `x-rakazo-space-id`，不要把此身份字段放在模型工具参数中。页面只显示密钥配置状态；模型只能看到工具输入 schema，不应看到 secret。源、工具分配及通用工具审批是不同层次，已有强制审批规则照常生效。

## 工具与结果契约

源只列出 `read_synthetic_load`，有只读声明；数据访问只执行固定源的 GET。注册后模型通常看到 `mcp__readonly-example__read_synthetic_load`（以实际发现结果为准）。遵循仓库已有 read 命名规则，不修改通用审批分类。

```json
{"date":"2026-11-08","version":"synthetic-load-v1"}
```

version 可省略并默认当前固定版本。额外字段、非法日期和未知版本拒绝。成功数据为：

```json
{
  "ok": true,
  "source": {
    "kind": "synthetic",
    "sourceId": "synthetic-load-example",
    "workspaceId": "REPLACE_WITH_TEST_BUSINESS_SPACE_ID",
    "version": "synthetic-load-v1",
    "generatedAt": "2026-11-07T16:00:00+08:00",
    "timezone": "Asia/Shanghai"
  },
  "date": "2026-11-08",
  "candidateOnly": true,
  "periods": [
    {"start":"2026-11-08T00:00:00+08:00","end":"2026-11-08T01:00:00+08:00","forecastMWh":12.5},
    {"start":"2026-11-08T01:00:00+08:00","end":"2026-11-08T02:00:00+08:00","forecastMWh":13.5}
  ]
}
```

这只是已列出的两个小时，不是全天总量。源输出必须通过结构、时段顺序 / 边界、工作区、日期与版本校验，最大 64 KiB；错误响应或超限响应不会作为原文交给模型。

MCP 响应包含 `structuredContent` 和相同 JSON 的 text。既有连接器删除成功结果中重复的 text，**`content:[]` 与完整 `structuredContent` 同时出现是正常情况**。这是运行时交给模型的工具结果；页面使用下面的持久化安全摘要，不读取原始结果或 Bot 回复来判断状态。失败保留 text，现有工具错误解析将其记录为失败。

| 代码 | 触发条件 | 自动含义 |
| --- | --- | --- |
| `INVALID_QUERY` | 非法参数或未知工具 | 修正参数后重试 |
| `SOURCE_TIMEOUT` | 源读取在配置时限内未完成 | retryable=true；没有旧数据回填 |
| `SOURCE_UNREACHABLE` | 网络连接失败或源返回其他失败状态 | retryable=true；修复源后主动重试 |
| `SOURCE_INVALID_RESPONSE` | 非 JSON、结构 / 范围 / 版本 / 时段不符或响应过大 | 修复数据源；不返回未校验正文 |
| `SOURCE_AUTH_FAILED` | 源拒绝服务端配置的模拟凭据 | 检查连接配置，勿让模型索要参数中的 token |
| `SOURCE_NO_DATA` | 源对请求日期返回 404 | 当前固定数据不存在该日期 |

失败结构为 `{ok:false,error:{code,message,retryable}}`，MCP 同时 `isError:true`，不含 periods。retryable 只是可重试提示，不会新增自动循环、隐藏失败或记账。MCP 服务本身不可达时，沿用既有连接健康 / MCP 传输错误，而非假装取得源侧错误码。

## 聊天状态与安全来源回读

普通聊天消息的 `runId` 可直接查询 `runs.detail({runId})`，不要求工单关联；完整空值、状态与权限说明见 [Run 接口](eTraderBot-run-trace-api.md#08-普通聊天与安全结果摘要)。`toolTrace.calls[].status` 是实际调用记录，`steps` 次数、Run 完成或 Bot 文字均不代表工具成功。缺失历史为未记录；未知结果为 ambiguous；撤销拒绝为 refused；源失败为 failed。

`calls[].resultSummary` 是白名单、限长的持久化结果。成功时仅有 `kind:"readonly_source"`、`schemaVersion:1`、`outcome:"success"`、上述 source/date/candidateOnly/periods；失败时仅有 kind/schemaVersion、`outcome:"error"`、workspaceId/errorCode/retryable。错误正文、原始参数、凭据和其他键不回传。最多 24 时段、JSON 8 KiB；来源必须属于该 Run 工作区。旧数据、其他工具、非法摘要或拒绝 / 未知结果的摘要为 null，不猜测补全；后端读回时仍重新投影校验。

新增迁移 `20261201120000_run_tool_result_summary` 只增加可空列和长度约束，没有历史回填。启动更新后的独立验收 API / worker 前，使用现有迁移流程在**明确指定的验收库**应用迁移并更新 Prisma client。此轮未迁移开发 / Desktop 原库。刷新页面可回读已存摘要，无须重新执行工具；重试是新的调用，保留之前失败。

## 完整演示与 Desktop 接续

1. 在隔离交易业务选一个风控或复盘 Bot，记下 workspaceId、Bot ID 和现有业务证据数。按上文启动样例、登记并仅授权该 Bot；核对保存后页面无明文凭据。
2. 正常对话（不需工单）要求读取 `2026-11-08` 合成负荷预测。若既有审批策略要求确认，通过原审批卡完成。按消息 runId 核对 `runs.detail` 的 completed 及安全摘要，再在页面展开来源核对 source.kind、workspaceId、版本、生成时间、两个时段及 12.5 / 13.5 MWh；刷新后仍一致。Bot 回复文字不能替代页面状态 / 来源，不宣称真实观测或交易结果。
3. 核对调用的 Run / 工具记录和候选来源；原业务证据 / 交易授权没有因查询而新增。真实模型能否正确解释该结果需单独观察，离线确定性运行不证明模型质量。
4. 在另一入口取消 Bot 的源分配、移除该工具白名单或禁用源，再次正常请求必须拒绝。切换另一业务，不能用旧 serverId 配置或调用源。CLI 另有“运行已缓存工具后撤销”的隔离回归；浏览器验收不要用静态隐藏按钮替代后端拒绝。
5. 查询 `2026-11-09`，应得到 `SOURCE_NO_DATA`。分开启动两个组件时停止 source，保留 mcp，再读应得到 `SOURCE_UNREACHABLE`；重新启动 source，再次读应恢复，不自动写证据。不要停止他人的服务。
6. 超时和格式不符已由真实本地 HTTP fixture + MCP 客户端定向回归；若要浏览器复测，在**独立临时源**中延迟返回超过 timeoutMs 或返回非法 JSON，让 `sourceUrl` 指向它，保持 MCP 组件运行。不得改验收业务证据或共享服务制造故障。
7. 打开保留的旧 Run：无 trace 覆盖标记或摘要时显示未记录，不能从 steps / Bot 文字回填来源或成功状态。失败、拒绝、等待和未知结果都不能显示成功图标；错误摘要只显示错误码的本地化说明，不渲染原始正文。检查网络响应和页面均无模拟凭据、原始参数及错误正文。切换业务或失去成员资格后不能继续展示缓存的旧业务资料。

配置与消息展示由 Claude 在已有页面接入；本轮后端补充不代表页面已完成。等 Claude 更新后再进行以上整票验收。没有新建原生页面，Electron 共用 Web；移动端缺少对应展示入口时不得用旧 steps 声称成功或已展示来源，未经验证不能宣称移动端验收通过。交付状态见 [08 实施记录](../implementation/eTraderBot-foundation-08-readonly-tool-example.md) 与 [后端展示补充](../implementation/eTraderBot-foundation-08-tool-display-backend.md)。
