# 09：主管派单与失效 attempt 收敛修复

2026-11-07，工作树 `platform-foundation`、分支 `feat/platform-foundation`，开始 HEAD `29f80c493acea0f467c348f1197c2f5fb5cfef88`。依据 D1 交接（本地证据 `.scratch/etraderbot-foundation/coordination/09-D1-manager-assign.md`，不在仓库中）、D2 交接（本地证据 `.scratch/etraderbot-foundation/coordination/09-D2-stale-attempt.md`，不在仓库中） 与 原 Desktop 验收（本地证据 `.scratch/etraderbot-foundation/acceptance/runs/accept-09-20261107-ae73c2/report.md`，不在仓库中）。按 D1、D2 顺序实施，不改原验收库或补写原现场状态，不提交、推送或关票。

## D1：工具命令适配

`BusinessCycleCommandSchema` 接受 operation 判别字段，服务的 `BusinessAssignInputSchema` 严格拒绝它。原工具把整个命令透传，使正常主管派单触发校验异常，再被写入未知分支转成 uncertain。单元及真实会话 / 执行器 / 数据库回归均先得到原失败，之后才修改。

`assign` 显式传入 cycleId/requestId/kind/dependsOn；`analyze` 显式传入 cycleId/deskId/margin。analyze 旧实现也透传 operation，但当前服务没有因此拒绝，多余字段是适配隐患，统一修正。list 无输入，read/settle 传 cycleId，complete 传 ticketId/result/expectedResultEvidenceId，均有定向断言；保留 complete 的 null 与未提供语义。

所有 strict schema 保留。调用服务前的命令校验错误返回安全的 `INVALID_INPUT`，不回显参数或 Zod 正文；已进入服务的非领域异常继续返回 uncertain，因为可能发生在事务提交之后的读回阶段。没有将所有 ZodError 一律当作“未写入”。TradingError 的原 error/code 和 `call.finish` 的效果记账失败语义保留。

真实工具测试由主管聊天发起两个相同 requestId 的合同覆盖派单，再以相同键改派 risk_check：前两次成功，后一项 IDEMPOTENCY_CONFLICT；只有一个 BusinessCycleWork / Ticket / Task / 专业 Run。效果记录校验的是 `toolEffectIdempotencyKey(runId, business_cycle, args, occurrence)` 的两个准确键；同一现场两次调用各自有记录，业务请求键阻止重复任务。主管 createdByBotId 与专业负责人均正确，无交易执行或角色扩权。没有以文字相似判断重复。

## D2：旧尝试状态收敛

旧实现只在原执行器 finally 中把遗留 running attempt 标为 interrupted。SIGKILL 后 finally 永远不会运行，新认领又只更新 Run，导致旧 attempt 残留 running，即使新尝试已等待或完成。

在成功取得更高租约 fence 后，执行器收敛该 Run 内 `fence < 新 fence && status=running` 的旧尝试，写入 interrupted / finishedAt；初次认领没有旧 fence 时不做清理。finishedAt 是确认失效的收敛时间，不伪称精确死亡时间。不更改调用行、旧错误、证据、历史等待状态或当前 / 更高 fence 的尝试。旧 worker 再次调用工具仍由原租约检查拒绝。

原 queued / leased / running / waiting_takeover 认领规则、waiting_input 必须经有效人工回答才入队的规则保持。未新增调度器、后台历史回填或数据库迁移；原冻结库中已存在的 orphan attempt 不会被本会话改写。新代码在后续成功认领时收敛仍活动 Run 的旧尝试，不能把这一点说成修复了所有已结束历史记录。

## 修改范围

- `packages/adapters/src/run-tools-trading.ts`：命令适配及确定输入失败分类。
- `packages/adapters/src/executor.ts`：成功认领新 fence 后收敛旧 running attempt。
- `packages/adapters/src/run-tools-trading.test.ts`：新增六 operation、严格输入拒绝、可能提交后的解析 / 基础设施异常与领域拒绝测试。
- `packages/testkit/src/run-recovery.postgres.test.ts`：复用原恢复夹具，增加主管真实工具入口到持久化与精确请求键 / 效果键断言；原 04 的恢复 / 等待 / 停止回归保留。
- `packages/testkit/src/run-recovery-process.ts`、`run-recovery-process.postgres.test.ts`：在现有真实子进程测试上增加恢复后提问 / 回答步骤和 SIGKILL 永不返回路径，比较效果键、业务请求键、证据行及评论行。

公开 RPC、严格 schema、工具命令结构、数据库结构和 Web 前端均未修改。已有 08 修复、其他会话改动和验收资料保留。

## 验证与证据

证据目录 `.scratch/etraderbot-foundation/09/backend-fixes-20261107/`；各运行新建 Testcontainers、文件级克隆库、临时数据目录。配置端口 3599/5669，进程测试真正监听随机端口。只操作这些测试资源；没有使用原 `accept-09` 库、容器或附件。

| 命令 / 日志 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/adapters/src/run-tools-trading.test.ts`；`d1-red.log` | 修复前 3 失败 / 6 通过，退出 1；适配和明确输入错误断言可区分原问题 |
| `run.mts packages/testkit/src/run-recovery.postgres.test.ts -t 09-D1`；`d1-db-red.log` | 修复前真实工具返回 uncertain，1 失败 / 4 未选中；修复后 `d1-db-green.log` 1 通过 / 4 未选中，未选中不计通过 |
| `run.mts packages/testkit/src/run-recovery-process.postgres.test.ts -t 09-D2`；`d2-process-red.log` | 原实现 SIGKILL / 自然租约过期后得到 running、waiting_input，1 失败 / 3 未选中，退出 1，约 329 秒 |
| `pnpm exec vitest run packages/adapters/src/run-tools-trading.test.ts packages/adapters/src/run-tools.test.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/adapters/src/approval-effect.test.ts packages/adapters/src/executor-start-timing.test.ts packages/adapters/src/executor-completion.test.ts packages/adapters/src/run-lifecycle.test.ts`；`unit-final.log` | 7 文件 161 项通过，退出 0 |
| `run.mts packages/testkit/src/run-recovery.postgres.test.ts packages/adapters/src/run-effects.postgres.test.ts packages/adapters/src/run-wakeup.postgres.test.ts`；`postgres-final.log` | 3 文件 18 项通过，退出 0 |
| `run.mts packages/testkit/src/run-recovery-process.postgres.test.ts -t 09-D2`；`d2-process-confirmed.log` | 1 通过 / 3 未选中，退出 0，无未处理异常；316.18 秒，SIGKILL / 自然租约 / 人工等待回答 / 完成全路径 |
| `pnpm --filter @rakazo/adapters check`；`types-adapters-rerun.log` | 通过，退出 0 |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/09/backend-fixes-20261107/tsconfig.json`；`types-tests-confirmed.log` | 四个新增 / 修改测试及辅助程序的最终定向类型检查通过，退出 0 |
| `pnpm exec biome check` 加上述六个 TypeScript 文件；`biome-final.log` | 6 文件通过，退出 0，无自动修改 |

以上 `run.mts` 的完整前缀为 `pnpm exec tsx .scratch/etraderbot-foundation/09/backend-fixes-20261107/run.mts`。没有重跑全部业务演练或整套模型验收。

中间一次进程测试在 Prisma 客户端生成时遇到并发 `ENOTEMPTY`，没有进入测试；同时间两次类型检查读到不完整的生成文件而失败。保留 `d2-process-green.log`、`types-adapters.log`、`types-tests-final.log` 的失败记录；停止并发生成后由同一隔离 runner 串行重新生成，随后两项类型检查通过，不修改 Prisma schema 或清理其他会话数据。后续并行测试应先统一完成 generate，再运行无生成步骤的检查。

`d2-process-final.log` 的业务断言通过，但调用者漏建日志目录产生两个 ENOENT，进程退出 1，**不计成功**。已预建新的专属 `process-confirmed/` 目录并重跑同一用例；不忽略未处理异常，也不扩大测试范围。最终结果以 `d2-process-confirmed.log` / `.exit` 为准。

新的 SIGKILL 场景精确卡在业务结果提交后、ExternalEffect 记账前：旧进程直接被杀，不运行退出钩子；等待原五分钟租约自然过期，不改租约或系统时钟。新进程靠原 reconciler / queue 发现同一 Run，先进入 waiting_input；人工经实际 HTTP 回答后第三个 attempt 完成。实际三次状态为 interrupted → waiting_input → completed，fence 为 1 / 2 / 3，等待记录及旧调用行原样保留。以同一效果键从 intended 到 completed、BusinessCycleWork.requestId、相同证据行和评论 ID / 全行，以及同一 Task/Run 核对去重，不凭文本相似或单纯数量推断。实际两个进程、收敛时间、效果键、证据及评论 ID 见 `d2-process-confirmed.log`；`process-confirmed/` 保留两份子进程日志。

旧 04 定向回归仍覆盖业务写入前失败、提交后失败、两 worker 认领、旧尝试复活被 fencing 拒绝、已停止不恢复、等待期间迟到投递不继续及有效回答才恢复。效果单元 / PostgreSQL 回归保持原稳定重试键、provider call ID 变化重放与不确定外部效果不盲重放语义。

不同 effect key / requestId 或不同有意现场 occurrence 仍是不同动作。本轮没有按评论文本相似合并，也不能据此保证真实模型主动换键的语义重复自动消失；原现场三条不同进度评论不被追认成重复写。

## Desktop 定向补验及保留缺口

1. 冻结更新代码到新的独立副本 / 库，保留原 `accept-09` 数据和报告。D1 从主管正常会话只派合同覆盖任务，核对实际 business_cycle 成功、createdByBotId、请求键、唯一工单与专业 Run；不能以人工页面派单代替主管自主调用。
2. D2 在自己的新演练 Run 运行中杀死该独立应用进程，PG 保持运行；重启并等待自然租约到期。只读核对旧 attempt interrupted 且 finishedAt 有值，恢复后的有效等待不被提前结束；回答后新 attempt completed，旧等待状态与调用历史保留。页面只显示尝试分组，不能把本缺陷误称成页面一直转圈。
3. 精确去重可在冻结副本复跑上表单个 09-D2 测试及 04 定向测试；保留请求键、效果键 / 状态、证据和评论 ID。重试只改变 provider call ID 不应另建业务结果，不用文字相似认定成功或失败。
4. 已通过的真实模型任务、替换负责人、Skill 读取和 MCP 合成查询沿用原证据，不重复整票。**撤权后缓存工具真正执行并返回 refused 的本轮真实模型证据仍缺失**；工具不可见、没有调用行或跨业务 RPC 404 都不替代它。之前 08 的隔离执行器拒绝测试也不算本轮真实模型结果。

本轮新增验证使用确定性运行时代替模型，真实 OS 子进程 / PostgreSQL / HTTP，但唤醒驱动为 memory；未新增真实模型、浏览器、Graphile 多进程、Electron / 原生移动端或完整 CI 结论。不修改旧现场以制造通过，09 保持 in-progress，交 Desktop 独立补验。

交付检查：六个代码文件的冻结值见证据目录 `code-hashes.json`；开始时记录的 974 份前端及验收文件均未变化，见 `preservation-final.json`。`git diff --check` 和文档相对链接检查通过。当前分支及 HEAD 与开始一致，未提交、推送或关票；原 Desktop 报告不改写为通过。
