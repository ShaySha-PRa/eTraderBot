# 08：聊天真实工具状态与安全摘要（后端补充）

2026-11-07；工作树 `platform-foundation`，分支 `feat/platform-foundation`，基准 HEAD `a6cf2bd9cc8b7cce1fbb438ed1e874337f702c5c`。依据 08 交接（本地证据 `.scratch/etraderbot-foundation/coordination/08-readonly-tool-example.md`，不在仓库中） 与 [Claude 前端缺口记录](eTraderBot-foundation-08-readonly-tool-frontend.md)。后端补充已交付，等待 Claude 接入及 Desktop 整票独立验收；没有修改前端、提交、推送、关票或启动 09。

## 核实及修复

原聊天 steps 只含工具名 / 次数，不保存结果或可靠状态。02 的 `runs.detail({runId})` 已支持普通聊天、当前用户和工作区检查，故复用该接口及 RunToolCall，不新增聊天执行或调度机制。通过消息 `runId` 查询，`ticket:null` 不影响工具记录；不能用工单页面是否可见来限制普通聊天读取。

原 MCP 明确的未分配 / 已停用错误没有结构化拒绝标识，工具追踪将其记作 failed；本次给连接器事件增加可选字面量 `code:"FORBIDDEN"`，只转发此确定标识，持久化为 refused。调用未返回结果时记为 ambiguous。原 failed、waiting、丢失租约 / 未记录终态的 ambiguous 语义保留；Run 完成及 Bot 自述不代表工具成功。

解析后的 MCP `read_synthetic_load` 路由才提取候选摘要，经过连接器密钥过滤后按白名单投影。摘要与工具终态同一次 update 写入，沿用 pending 条件避免覆盖已记录结果；写入失败不重放工具副作用，原未确定结果机制继续有效。API 回读再次校验 / 投影；不从自由文本或原始参数重建历史。

共享契约见 [Run API](../integration/eTraderBot-run-trace-api.md#08-普通聊天与安全结果摘要)。新增字段 `resultSummary?: SafeReadonlySourceSummary | null`；新服务端始终返回字段，optional 兼容旧客户端数据。成功摘要包含固定合成来源、同业务 workspaceId、版本、生成时间、日期、候选标记和时段值；失败仅包含稳定错误码及可重试标记。其他工具、缺失 / 非法摘要及拒绝 / 未知结果返回 null。没有原始参数、凭据、源错误正文或任意描述字段。ISO 时间最长 35、日期 10、workspaceId 128、24 时段、JSON 8 KiB；数值有限非负且时段合法。

权限没有放宽：沿用用户、业务和当前成员资格；跨用户 / 跨业务 Run 拒绝。撤销成员资格后认证 HTTP 请求被现有身份层拒绝；直接服务层按原 FORBIDDEN 处理。撤销源授权不删除以前合法取得的历史；后续调用拒绝，失去业务访问权则不能读该业务历史。本轮不增加交易权限或正式证据写入。

## 修改文件

| 文件 | 本次增量 |
| --- | --- |
| `packages/contracts/src/tool-result-summary.ts`、`run-trace.ts`、`index.ts` | 封闭摘要 schema / 导出，工具记录新增兼容可空字段 |
| `packages/core/src/readonly-source-summary.ts`、对应 `.test.ts`、`index.ts` | 写入 / 回读白名单投影、范围 / 长度 / 状态检查及测试 |
| `packages/db/prisma/schema.prisma`、`migrations/20261201120000_run_tool_result_summary/migration.sql` | 可空 JSONB 摘要列、数据库长度约束；不改旧迁移 |
| `packages/adapter-kit/src/types.ts` | ConnectorEvent error 新增可选 `code?:"FORBIDDEN"`，现有提供方无需修改 |
| `packages/adapters/src/mcp-connector.ts`、`run-tools-integrations.ts` | 明确拒绝分类的传递，不透传任意错误码 |
| `packages/adapters/src/run-tools.ts`、`run-tools.test.ts` | 持久化样例摘要，无返回结果保持未知；保留原 gate、lease、Effect 流程 |
| `apps/api/src/run-trace.ts`、`run-trace.postgres.test.ts` | 当前权限下安全回读，历史 / 超限 / 敏感字段回归 |
| `packages/testkit/src/readonly-source.postgres.test.ts` | 真实执行器 / MCP 后经认证 HTTP RPC 回读成功、失败和撤销结果 |

另更新本记录、两份 integration 文档、08 初次实施记录的补充指针、任务票和 coordination 交接。原前端记录及验收文件保留。开始快照的 887 个 Web / 验收资料文件哈希无变化；定向 diff 审核确认没有抹除其他票的修改。未执行全仓格式化。

## 迁移与部署边界

迁移仅增加 `run_tool_calls."resultSummary"` 可空列与 8192 字节 JSONB 约束，兼容旧版本忽略此列；旧行默认 null，不回填、不改写原包、消息、证据或记录。仅在新建隔离 Testcontainers 库应用并验证；未操作开发业务库、Desktop 库、附件和服务。

Claude / Desktop 使用自己的独立验收数据库，通过原迁移流程应用新增迁移并更新 Prisma client 后，再启动最新 API / worker。不能在缺列旧库直接启动新 worker。后续实际调用才产生摘要，旧记录必须继续显示未记录。无需重跑旧工具来“补全”历史。

## 本次验证

证据目录：`.scratch/etraderbot-foundation/08/display-backend-20261107/`。独立 Testcontainers、每测试文件克隆库及 `/tmp/etrader-08-display-*` 数据目录；预检端口 3595/5665，本地 MCP 使用随机端口，应用 HTTP 进程内调用。没有浏览器或真实模型；只清理本次临时资源。

| 命令 / 日志 | 结果 |
| --- | --- |
| `pnpm exec tsx .scratch/etraderbot-foundation/08/display-backend-20261107/run.mts packages/testkit/src/readonly-source.postgres.test.ts apps/api/src/run-trace.postgres.test.ts packages/testkit/src/live-business-authorization.postgres.test.ts`；`postgres-final.log` | 3 文件 19 项通过，退出 0：样例 8、Run 查询 7、实时授权 4 |
| `pnpm exec vitest run packages/core/src/readonly-source-summary.test.ts packages/adapters/src/run-tools.test.ts packages/adapters/src/mcp-connector.test.ts packages/adapters/src/examples/readonly-source.test.ts`；`unit-final.log` | 4 文件 127 项通过，退出 0 |
| `pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapter-kit --filter @rakazo/adapters --filter @rakazo/api check`；`types-final.log` | 6 个相关包通过，退出 0 |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/08/display-backend-20261107/tsconfig.json`；`types-tests-final.log` | 两个变更数据库测试文件及依赖聚焦类型检查通过，退出 0 |
| 本次 14 个 TS 文件 `pnpm exec biome check`、`git diff --check`、修改文档相对链接检查 | 通过；见证据目录日志 |

定向断言与证据边界：

- **成功**：普通聊天没有 Ticket，走原队列 / 执行器、真实本地 HTTP 源和标准 MCP；完成后认证 HTTP `runs/detail` 返回 completed、完整候选来源与 12.5 / 13.5 MWh。直接核对持久化摘要一致；清空测试运行时的结果缓冲后重新请求仍一致，不依赖内存工具结果。业务证据和交易权限不变。
- **源失败**：停止本轮源，MCP 保留运行。实际工具记录 failed、安全错误码 SOURCE_UNREACHABLE；没有成功候选数据、原始错误或模拟凭据。
- **撤销**：已发现工具后分别撤销 Bot 分配、工具白名单、源启用、业务成员、Bot 有效性，实际记录 refused/null；源 / 工具 / Bot 撤销后仍有业务权限者可查看拒绝记录，成员撤销后 HTTP 读取被拒绝。同用户跨业务与未分配 Bot 调用拒绝，原 Run API 跨用户 / 业务 / 撤权回归保持通过。
- **历史及未知**：旧 Run 覆盖标记不变、不补填；缺失摘要为 null。已结束 attempt 中 pending 调用、丢失租约等为 ambiguous；没有返回结果的调用也为 ambiguous，不配成功摘要。测试构造不匹配状态的成功 JSON，API 不将其展示为成功。
- **敏感信息**：写入投影对根字段、source、periods 中的模拟凭据 / 参数 / 任意文本逐层过滤；非法标识、越界长度和时段拒绝。隔离库直接置入带模拟敏感附加字段、跨业务来源的 JSON，API 回读仅白名单或 null，数据库原测试历史保留不被静默重写；超过 8 KiB 的插入被数据库约束拒绝。源错误只提供稳定枚举，不回显 message。

开发红灯 `display-red.log` 保留：修复前正常聊天 RPC 无 resultSummary，定向断言失败（1 项失败、7 项未选中），之后才实施。早期绿色日志不替代以上最终组合验证。

## Claude 交接与 Desktop 复测

请使用者转交 更新后的 08 契约（本地证据 `.scratch/etraderbot-foundation/coordination/08-readonly-tool-example.md`，不在仓库中） 给原 Claude，不假设文件已被收到。前端按消息 runId 展示实际 calls，兼容 null/undefined 与 recorded:false，不把聚合 steps 映射成确定结果；展开摘要显示来源 / 范围 / 日期时段 / 版本 / 候选标记，错误使用枚举翻译。缓存按用户和业务隔离，切换 / 撤权后不可保留旧业务内容；复用现有刷新机制。

Claude 接入后 Desktop 按 [完整演示](../integration/eTraderBot-readonly-tool-example.md#完整演示与-desktop-接续) 在独立应用验收：普通聊天查询、页面来源及刷新回读；源停止和恢复后新调用；撤销后的拒绝；历史缺失和未知状态；跨业务缓存 / API 拒绝；页面和网络无模拟秘密或原始正文。以页面、RPC 与实际工具记录共同核对，Bot 回复不替代页面状态。

本次未运行浏览器、Electron、移动原生端、真实模型 / 真实外部系统、Graphile 多进程或全仓 CI。脚本运行时证明后端路径，不证明模型解释质量，也不证明前端加载和展示正确。移动端未接入时只能保持安全降级，不能声称来源展示通过。08 保持 in-progress，等 Desktop 独立验收。
