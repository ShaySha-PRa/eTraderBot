# 业务范围与接口配置 API

共享契约：[trading-workspace.ts](../../packages/contracts/src/trading-workspace.ts)。全部入口使用既有认证 RPC `/rpc/trading/<procedure>`，身份和 Space 来自会话，不由输入自报。

| Procedure | 主要输入 | 结果／权限 |
| --- | --- | --- |
| `workspaces` | `{}` | 当前 Space 的零或一个业务配置，包含 `deskIds`、可见且未归档的 `botIds`；名称来自 Space |
| `createWorkspace` | 可选重试 `id`、`name`、不含阶段的 `scope`、两类审批人 ID | 经确认身份配置当前 Space；仅业务所有者可操作，审批人必须是该 Space 成员，已有不同配置拒绝 |
| `createBusinessScope` | 与 `createWorkspace` 相同 | 原子新建隔离 Space 及配置；初始审批人只能为创建者，重试 ID 同时作为新 Space／配置 ID |
| `connectWorkspaceBot` | `workspaceId`、`botId` | 所有者给本 Space 内的已有模板 Bot 补齐场景绑定；跨 Space 拒绝；原子创建／复用适用场景、绑定、学习计划 |
| `interfaces` | `workspaceId` | 仅范围所有者；返回配置与 `hasSecret`，不返回密钥或密钥引用 |
| `saveInterface` | `id`、`workspaceId`、`name`、`purpose`、`config`、可选 `secret`、`expectedRevision` | 所有者经身份确认保存；创建修订为 0，修改使用读取的修订号 |
| `removeInterface` | `workspaceId`、`id`、`expectedRevision` | 所有者经身份确认删除；过期修订拒绝，密钥持久记录随之清理 |

`spaces/list` 是跨业务导航的唯一来源。界面选择的是 `Space.id`，随后切换 RPC 的 Space 上下文；`workspaces` 仍只读取当前业务的交易配置。名称修改沿用 `spaces/rename`，所有界面以 Space 名称为准。

`bots/create` 的 `spaceId` 来自认证上下文。传入 `tradingRole` 时，服务端自动使用当前 Space 的配置；可选 `tradingWorkspaceId` 仅用于校验或兼容旧客户端，不能借此跨业务绑定。没有交易配置的旧调用可以创建未绑定模板，但 Web／移动创建界面要求先完成配置。普通 Bot 不需要交易配置，也始终属于当前 Space。Bot、适用阶段绑定与学习计划原子写入，不继承批准或授权。

`createWorkspace` 的 `name` 保留输入兼容性；配置现有 Space 不改名。主体／账户或审批策略不同，必须创建另一业务范围。新建业务先只包含创建者；原有已配置 Space 的两类审批人保持原值。

迁移 `business_spaces` 对 `TradingWorkspace.spaceId` 建立唯一约束，保持全部既有证据 ID 与加密内容；多套旧配置共用一个 Space 时拒绝迁移，须另行明确历史归属后再执行，禁止直接删配置或改证据绕过检查。

`purpose` 为 `market_data | forecasts | positions | rules | execution | receipts | other`。

HTTP 配置（虚构地址，凭据单独传入，不放入 URL、查询参数或请求体）：

```json
{
  "transport": "http",
  "url": "https://api.example.test/prices",
  "method": "GET",
  "query": { "region": "CN-SD" },
  "body": "",
  "auth": "header",
  "authName": "X-API-Key"
}
```

`auth` 支持 `none`、`bearer`、`header`、`query`；后两者必须指定字段名。GET 不允许请求体。URL 只允许 HTTP(S)，拒绝内嵌用户名、密码及片段。新认证配置必须提供凭据；编辑不传 `secret` 保留原值。切换无认证或 MCP 时移除已存凭据。机密保存在既有 SecretStore，配置 DTO 不含明文。

MCP 配置为 `{ "transport": "mcp", "serverId": "synthetic-connection-id" }`。引用必须属于当前用户，并可用于当前 Space；不复制 MCP 密钥、不自动扩大 Bot 工具分配。

当前 `status` 固定为 `configured`，界面显示“已配置 · 未验证连通”。这些接口只管理配置，不发出外部 HTTP 请求、不替换当前合成快照、不实现任意 JSON 到交易契约的自动映射。下一接入阶段须通过既有外部契约对接快照、规则和执行状态，补连通测试、来源时效、读取权限和失败反馈；保存条目不代表完成该阶段。
