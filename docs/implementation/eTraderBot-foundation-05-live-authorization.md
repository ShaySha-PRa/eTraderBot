# 05：运行中的业务结果提交使用当前权限

2026-11-07。工作树 `platform-foundation`，分支 `feat/platform-foundation`，基准 HEAD `de2b7967c2b7353d621b31ffce4ee44bc0fed4c1`，保留原有未提交修改。依据 `.scratch/etraderbot-foundation/issues/05-live-authorization.md`。

**后端已交付；05 整票仍待 Claude 页面拒绝反馈与 Desktop 独立验收。** 未提交、推送或启动其他票，未操作开发业务库、Desktop 服务或附件。没有改前端、执行器、租约恢复或共享 RPC 契约。

## 动作和权限契约

选取已有 `businessCycle.complete`（HTTP `/rpc/businessCycle/complete`），工具对应 `business_cycle` 的 `operation: "complete"`。

| 字段 / 行为 | 本轮语义 |
| --- | --- |
| `ticketId` | 必须属于当前身份的当前业务；不从输入取得用户或 Bot 角色 |
| `result` | 既有总结、证据引用、分歧、未解决事项和未启用改进建议；结构不变 |
| `expectedResultEvidenceId` | 省略 / `null` 表示没有前序结果；修改已有结果必须携带当前版本。原有完全相同重放及乐观并发语义不变 |
| 人工代办 | 当前业务所属用户仍有工作区成员资格；不要求人工取得 Bot 身份或冒充负责人 |
| Bot 提交 | 重新查询持久化身份；Bot 有效、属于当前用户和业务、是当前任务负责人、专业角色符合任务种类且不是主管 |
| 拒绝 | 业务服务 `FORBIDDEN`；RPC 同码并有 `data.reason=FORBIDDEN`。不可见任务可为 `NOT_FOUND`。证据 / 版本问题继续是 `BAD_REQUEST` + `MISSING_EVIDENCE` / `STALE_DATA` 等原原因 |
| HTTP 成员资格撤销 | 现有 session-to-workspace 解析得不到 Actor，返回 **401 / `UNAUTHORIZED`**，而非业务服务的 403。本轮保留该现有契约 |
| 工具拒绝 | 领域服务返回 `{error, code}`；更早的工具身份准入可抛出拒绝。现有 RunToolCall 把权限拒绝记录为 `refused` |

本动作提交业务结果，不启用算法、不批准交易、不产生执行权限。人工身份确认、算法启用批准及交易批准 / 范围授权继续由各自原有动作检查。交易主管不能提交专业结果；风控 / 复盘的专业结果能力不扩大其交易写权限。

## 已确认缺陷与修复

旧 `complete` 调用 `ownedCycle(..., true)` 时，先读取成员资格及 Bot，再等待周期行锁。等待期间撤销成员资格或归档 Bot 后，旧身份仍用于追加证据、评论和改变任务状态。事务结束后的读取才返回 `FORBIDDEN`，形成“返回拒绝但业务已写入”。

新增测试在独立 PostgreSQL 事务持有真实 `business_cycles FOR UPDATE` 锁，通过 `pg_stat_activity` / `pg_blocking_pids` 确认提交连接已经等待，再用另一事务提交撤权、释放屏障。修复前归档与成员资格撤销两例均在“业务快照不变”断言失败；更换负责人已有锁后读取，作为对照通过。不是用睡眠推测竞争。

修复后在获得周期锁后调用 `lockBusinessResultIdentity`：对该工作区、成员、业务归属及提交 Bot 取得共享行锁，并重新调用现有身份校验；共享锁持有到结果事务结束。已先提交的撤权会被新检查拒绝；如果结果事务先取得授权行锁，撤权更新等待该事务结束。其他周期的授权读取可并行，不引入全局队列。负责人的正常变更继续由已有周期锁协调。

同时明确核对任务要求的专业角色及非主管身份，拒绝历史数据中负责人 ID 虽相符但角色不合的情况。Bot 角色本来就由数据库触发器禁止改变，本轮保留该不变量，没有为测试绕过角色触发器。

## 文件范围

- `packages/db/src/business-cycle-evidence.ts`：结果事务的当前身份锁与复核。
- `packages/db/src/business-cycle.ts`：`complete` 在周期锁后使用当前身份，校验专业角色；保留前序结果、证据版本、03 并发和 O3 自引用规则。
- `apps/api/src/business-cycle-fixes.postgres.test.ts`：新增 5 项 05 回归（含 3 个锁等待变更参数）；合法专业 Bot / 人工代办、跨业务 / 不匹配负责人 / 主管与错误角色拒绝、历史不变。
- `packages/testkit/src/live-business-authorization.postgres.test.ts`：新增 4 项正常 HTTP 派单 → 实际队列 → Task/Run / executor → 工具调用回归。
- `apps/api/src/workspace-isolation.postgres.test.ts`：旧工具隔离测试补真实 Task、Run、Attempt 与有效租约，使其适配已有 02 追踪和 03 工具准入；无产品隔离逻辑变更。
- 本文、05 任务票、`.scratch/etraderbot-foundation/coordination/05-live-authorization.md` 及 05 本轮证据目录。

没有数据库迁移。原有数据、证据、附件无需搬运或重写；只对下一次结果提交应用当前权限检查。

## 验证与证据边界

本轮证据：`.scratch/etraderbot-foundation/05/backend-20261107/`。本地 `run.mts` 复用仓库 Testcontainers PostgreSQL / process helpers；覆盖三个数据库 URL，使用独立容器及每文件测试库、临时数据目录，结束仅删除本轮容器和目录。预检 3571 / 5641，HTTP 在进程内执行，没有监听或重启 Desktop 服务。

实际执行的检查：

| 检查 | 结果 |
| --- | --- |
| PostgreSQL：business-cycle-fixes（19）、business-cycle（5）、human-intervention（6） | 30 项通过，见 `postgres-final.log`；同轮另两文件有下述测试适配失败，不能把该命令写成退出 0 |
| PostgreSQL：live-business-authorization（4）、workspace-isolation（5） | 适配后 9 项通过，命令退出 0，见 `rpc-isolation-recheck.log`。合计 39 个不同用例的最终结果通过 |
| `pnpm exec vitest run packages/core/src/trading packages/adapters/src/run-tools.test.ts packages/adapters/src/tool-result-error.test.ts` | 5 文件、56 项通过，退出 0，`unit-final.log` |
| `pnpm --filter @rakazo/db check` | 通过，退出 0，`types-db.log` |
| `pnpm --filter @rakazo/api check` | 通过，退出 0，`types-api-final.log` |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/05/backend-20261107/tsconfig.json` | 新增 HTTP/executor 测试及依赖的聚焦类型检查通过，退出 0；不是 testkit 整包类型检查 |
| 五个本轮 TypeScript 文件的 Biome、`git diff --check` | 通过；`biome-final.log` / `diff-check.log` |

数据库命令为 `pnpm exec tsx .scratch/etraderbot-foundation/05/backend-20261107/run.mts <以上对应测试路径>`。保留 `lock-red.log`（2 失败 / 2 通过）和 `lock-green.log`（4 通过）的缺陷证据。

测试编写过程的失败也保留：初稿尝试修改不可变 Bot 角色，被数据库正确拒绝，随后改为断言不变量；新 runtime 测试的排序字段、空数组被结构校验提前拒绝、`refused` / `failed` 分类、HTTP 401 预期均已按实际契约修正。旧 workspace-isolation fixture 缺少 Attempt，尚未到达权限断言即失败；补齐真实上下文后原隔离断言通过。这些不计为额外产品缺陷。

真实执行器测试先确认正常派单产生的 Run 为 `running`，再改变**隔离测试库**的成员资格、归档状态或有效负责人，让同一个缓存 RunContext 调用结果工具。该测试刻意保留 Run，不使用归档接口取消它，验证的是实时权限边界，不是“归档会取消运行”的端到端效果。拒绝后证据、BusinessCycleWork、Ticket、评论逐项不变，只有原一条 Run；工具拒绝有持久化追踪。正常控制组可提交一次，缺少必需引用和过期结果版本分别拒绝。

原回归覆盖 P25 的 23,700 元、82 MWh 更正后的 24,320 元、历史保留、双批准与角色约束，以及 03 的严格竞争和秘密重复回答。未将这些模拟结算称为净利润。开始快照所列 `apps/web` 与既有 Desktop 验收文件共 754 个校验值未变，见 `protected-comparison.json`。

## Claude / Desktop 待验证步骤

1. 使用明确指定的独立验收库和端口，保留 Desktop 原业务、数据目录及证据；不使用旧启动脚本隐式选库。05 CLI 未启动共享服务。
2. 创建模拟业务、主管和中长期 Bot，载入 P25，派发合同覆盖任务。打开该任务结果表单，填写总结、分歧、未解决事项及提案。
3. 通过该独立库的管理测试动作撤销当前用户的工作区成员资格，再由原页面提交。网络应为现有 **401 / UNAUTHORIZED**，业务证据、评论及任务结果不能变化；输入保留和拒绝提示必须由真实页面确认，不能用伪造响应替代。
4. 特别处理 `apps/web/src/lib/rpc.ts` 的 `leaveUnavailableSpace`：现有逻辑在 401 后可清除业务选择并 `window.location.reload()`。这条路径的草稿保留 / 提示尚未交付或验证，**不能把已有普通 403 或离线错误草稿测试当成通过**。
5. 切换另一个有权业务，确认旧 taskId、cycleId、证据 ID、预期结果版本和草稿不会作为该业务的操作上下文；人工代办合法结果仍可提交。恢复访问不应自动提交旧草稿。
6. 核对后端锁竞争与 runtime 记录，无需在浏览器人工制造严格数据库竞态。Electron 使用 Web 共用界面；移动端业务周期页目前只读，聊天工具使用同一后端校验，不增加原生结果编辑入口。

本轮没有运行浏览器、Electron、原生设备、真实模型、真实接口、Graphile 多实例恢复或全仓 CI；确定性 runtime 不能证明模型自然语言协作质量。05 页面需求已写入协调文件，未获得 Claude 接收或完成回执，整票继续保持 in-progress。
