# 02：工单与运行追踪（共享契约及后端）

2026-11-06；工作树 `platform-foundation`，分支 `feat/platform-foundation`，基准 HEAD `de2b7967c2b7353d621b31ffce4ee44bc0fed4c1`。05 尚未启动，按交接优先实施 02。共享契约先落地并通过类型检查，再在协调文件中写入 Claude 开工通知，随后继续后端。

**交付状态：共享契约、后端及定向自动化验证完成；前端、浏览器和 Desktop 独立验收待完成。** 当前会话没有直接投递到 Claude 的通道，协调文件保留开工通知与最终接口位置，未冒称已收到前端确认。未提交、推送或启动 04/05；保留 01/03/07 及其他会话修改。

## 实现范围

- 工单派单在原事务中写入 `Task.ticketId`，与 Task/Run 创建一起提交。业务周期派单复用同一路径。现有 routine 重试创建新 Task 时继承已记录的关联；恢复原 Run 保留原 Task。没有新增重试调度器，亦未将 routine 自动重试扩展到所有工单。
- `runs.forTicket` 返回当前用户、当前工作区的关联运行，支持稳定游标分页；`runs.detail` 返回独立的工单与运行状态、Bot、重试来源、安全原因分类、记录时间、用量及工具摘要。原 `runs.list` 不变。字段、空值和前端适配以 [接口说明](../integration/eTraderBot-run-trace-api.md) 为准。
- 原工具入口持久化名称、attempt、状态及起止时间，覆盖直接 executeTool 和流式工具事件。只记录摘要，不复制原始参数、结果、问题、凭据或错误正文；不把任意未知工具名原样返回。
- 成功、工具返回错误、准入拒绝、等待批准、结果不确定分别记录。停止或失去租约后不能发出新工具；已发出的操作不能宣称撤回。摘要终态写入失败不重试已经执行的工具，未定记录在原 attempt 失效或运行结束后显示 ambiguous，保留原历史与缺失时间。
- 费用只汇总同一用户、工作区、runId 的 UsageRecord。无记录、任一费用缺失或非 USD 时为 `costUsd=null, costKnown=false`；显式记录为零才返回零。不包含子 Run 或其他用户的记录，已记录费用不等于最终账单。
- 查询重新检查工作区成员资格；跨业务、其他用户或不存在的 Run 不可读。新增表使用强制 RLS。没有放宽主管、专业 Bot、普通 Bot 或交易审批权限。

## 迁移与旧记录

新增迁移 `20261130120000_run_trace`：可空 `Task.ticketId`、可空 `Run.toolTraceVersion`、`RunToolCall` 摘要表及查询索引、RLS。仅增加结构，兼容旧代码仍不填新字段的写入。

旧 Task 不解析 prompt 或标题补关联；旧 Run 不回填工具摘要或费用。新 Run 首次实际执行时启用捕获标记，旧 Run 恢复后已有的局部摘要不会被宣称为完整记录。工具列表最多返回 200 条，超过时 `truncated=true`，数据库历史不删除。

删除工单将 Task 关联置空，Run 和工具记录仍可读；归档 Bot 的现存 Run 可读。删除 Bot 仍遵守原有级联策略，已不存在的 Run 返回 NOT_FOUND，本票未新增永久历史保留系统。

迁移只在测试框架创建的隔离 PostgreSQL 验证，没有迁移开发业务库、启动开发服务、清理原附件或修改 Desktop 验收库。

## 改动文件

| 范围 | 文件 |
| --- | --- |
| 共享类型及 RPC | `packages/contracts/src/run-trace.ts`、`index.ts`、`rpc.ts` |
| 结构及隔离 | `packages/db/prisma/schema.prisma`、`prisma/migrations/20261130120000_run_trace/migration.sql`、`packages/db/src/row-security.ts` |
| 持久关联与工具采集 | `packages/adapters/src/ticket-wake.ts`、`run-routines.ts`、`executor.ts`、`run-tools.ts` |
| 查询及路由 | `apps/api/src/run-trace.ts`、`routes/content.ts` |
| 新增/扩展回归 | `apps/api/src/run-trace.postgres.test.ts`、`business-cycle-fixes.postgres.test.ts`、`packages/testkit/src/human-intervention.postgres.test.ts`、`packages/adapters/src/run-tools.test.ts` |
| 既有执行器夹具及 MCP 回归 | `executor-effect-idempotency.test.ts`、`executor-lazy-computer.test.ts`、`executor-login-redaction.test.ts`、`executor-mcp-session.test.ts`、`executor-readonly-approval.test.ts`、`executor-recent-turn-images.test.ts`、`executor-routine-failure.test.ts`、`executor-run-login.test.ts`、`executor-secret-origin.test.ts`、`executor-start-timing.test.ts`、`executor-user-progress.test.ts`（均在 `packages/adapters/src/`） |
| 记录 | 本文、接口说明及 02 本地任务票/协调文件/测试证据 |

本轮没有修改 `apps/web`。`run-tools.ts` 和两个 PostgreSQL 文件同时包含此前 03 的有效修改；本轮在其基础上补追踪，不撤回停止准入、回答幂等或结果版本校验。

## 验证结果

使用现有测试入口和临时数据目录，模型及外部操作均为确定性模拟。集成测试依次使用新 Testcontainers 数据库，API/Web 配置端口 3551/5621；认证 HTTP 测试调用进程内应用，没有启动浏览器或占用 Desktop 浏览器测试端口。

| 命令 | 结果（退出码均为 0） |
| --- | --- |
| `API_PORT=3551 WEB_PORT=5621 pnpm test:integration --spec=run-trace` | 6 项通过：真实派单关联及分页、旧记录/费用/时间空值、跨用户/工作区/撤权、重试继承与重复投递、工具状态/RLS/失效租约、截断及删工单保留历史。 |
| `API_PORT=3551 WEB_PORT=5621 pnpm test:integration --spec=human-intervention` | 4 项通过：认证 HTTP＋真实队列/executor，成功/返回错误/等待批准摘要、停止后的拒绝；回答并发和重发不重复执行，摘要不暴露文件名/正文/秘密。 |
| `API_PORT=3551 WEB_PORT=5621 pnpm test:integration --spec=business-cycle` | 18 项通过：业务派单的工单关联，以及原版本冲突、角色/隔离、审批、P25 23,700 元与 82 MWh 更正后 24,320 元回归。 |
| `API_PORT=3551 WEB_PORT=5621 pnpm test:integration --spec=executor-lifecycle` | 24 项通过，覆盖既有执行器生命周期。 |
| `pnpm exec vitest run packages/adapters/src/run-tools.test.ts packages/adapters/src/executor packages/db/src/row-security.test.ts` | 22 文件、796 项通过；包括 MCP isError 返回正确记录失败、摘要写入失败不重复执行、抛错不泄漏正文、原 MCP/凭据脱敏/副作用幂等/重试行为。 |
| `pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api check` | 4 包类型检查通过。 |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/03/tsconfig-focused.json` | 复用已有聚焦配置，HTTP/executor PostgreSQL 文件类型检查通过。 |

共 52 项隔离数据库集成回归及 796 项定向单元通过。新增采集先用 HTTP/executor 断言复现工具摘要未记录，再补实现；扩展执行器回归暴露的模拟 Prisma 缺表及首次开始字段预期已补齐，没有放宽生产校验。最后复查还通过现有 MCP 执行路径复现 isError 返回被误记 completed，复用已有 toolResultError 修正后重跑 796 项单元、4 项 HTTP/executor 集成和 adapters 类型检查，均通过。仅对本轮 25 个代码文件执行 Biome；`git diff --check` 通过。命令输出保留在 `.scratch/etraderbot-foundation/02/`，与 Desktop 证据目录分开。

## 尚未验证及 Desktop 复测

未运行全仓 CI、生产构建、浏览器、Electron、原生设备、真实模型或真实接口；不能将确定性执行器测试当作真实模型质量验收。本轮没有重新核验 03 记录中已有的 testkit 整包类型/Expo 版本/其他凭据套件问题。前端仍须落实中英文空态、状态更新、错误重试和移动端适用入口或安全降级。

前端接入后，在独立测试库应用迁移并执行：

1. 同一工单派单两次，从工单进入运行列表，核对不同 runId、时间和 Bot；运行结束仍单独显示工单业务状态。业务周期派单也应出现可靠关联。
2. 打开旧 Task/Run，确认“未记录关联运行/未记录工单关联/未记录工具摘要”，不因标题相同猜出关联。无用量、部分费用未知与明确零费用分别展示；非零金额按已记录费用展示。
3. 经已有正常会话制造等待、停止、完成和失败；刷新详情，核对后端持久状态、原因及工具摘要。等待工具不显示为已执行；停止时不宣称撤回在途操作。
4. 切换业务/用户，直接调用旧 runId/ticketId 应拒绝；撤销工作区成员后重新请求拒绝。归档 Bot 的现有历史可读；已删记录显示受控未找到。
5. 验证工具摘要不展示参数、正文、凭据或原始异常；长列表标明截断，旧 Run 仅有局部摘要时仍保留未完整记录提示。
6. 分别做英文和中文 390 CSS px 操作、刷新和网络错误后的重试；记录 UI、HTTP、Run/Task/Ticket ID，单独记录 Electron/移动端未验项。由 Desktop 独立出结论后再勾选任务票的页面验收项。
