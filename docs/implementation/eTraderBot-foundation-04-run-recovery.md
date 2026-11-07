# eTraderBot 基座 04：执行中断后安全恢复（交付记录）

2026-11-07，新 Claude 会话（04 专项）。分支 `feat/platform-foundation`，未提交、未推送。任务票：`.scratch/etraderbot-foundation/issues/04-run-recovery.md`。证据：`.scratch/etraderbot-foundation/04/recovery-20261107/`。

## 结论

受控模拟写入选用现有 `business_cycle` 的 `complete`（专业 Bot 提交业务任务结果；模拟环境，不涉及交易批准或执行）。恢复沿用现有机制：Run 租约与 fence、`ExternalEffect` 稳定幂等键、业务服务的精确重放确认、对账器只回收租约过期的 `leased/running`。没有新增状态机、表、契约或页面。

测试发现并修复了一个缺陷：中断后的结果被报告成“确定失败”或抛出原始异常，没有报告为“结果未知”。

## 修复

1. `packages/adapters/src/run-tools-trading.ts` 中的 `business_cycle`：写操作（assign / analyze / settle / complete）如因非业务错误失败（例如数据库连接中断，此时事务可能已提交），返回既有的 `uncertainEffectResult`，运行追踪记为 `ambiguous`（页面显示“Result unknown”），不再返回确定的 “Business cycle request failed”。参数错误和 list / read 保持原样。`TradingError` 的 `{ error, code }` 不变，03 的 `expectedResultEvidenceId` 透传也不变。
2. `packages/adapters/src/run-tool-gate.ts` 中 `createToolCall` 的 `finish`：业务已执行完、记录效果结果时抛错，按 `finish` 原有约定（存储失败即结果未知）处理。修复前，`return call.finish(value)` 在 `try` 内未 `await`，异常绕过处理器，原始 Prisma 错误直接抛给运行时。

记录结果未知后，效果行保持 `intended`。恢复时沿用同一幂等键重新认领并执行；业务服务识别出精确重放，只确认已有结果，不追加证据。

## 验证（`packages/testkit/src/run-recovery.postgres.test.ts`，本会话新增）

通过真实 API、PostgreSQL 和执行器运行，模型由确定性脚本运行时代替；同一业务下有两个专业 Bot。

| 任务票条件 | 覆盖方式 | 结果 |
| --- | --- | --- |
| 写入前中断 | 用行锁把第一次尝试卡在业务事务内，然后终止其数据库连接；业务未写入 | 通过 |
| 写入已持久化但响应未送达 | 业务事务提交后，用行锁卡住效果记账，然后终止连接；业务已写入，效果仍为 `intended` | 通过 |
| 恢复后定位原任务、运行和业务结果 | 租约过期后，对账器选中原 Run；恢复尝试完成原工单，结果、工单 done 与 Run 对应 | 通过（连接终止与租约过期模拟；真实进程重启未验证） |
| 重试或多实例竞争只形成一份副作用 | 两个恢复 worker 并发认领，fence 只放行一个；最终业务证据 1 条、评论 1 条、效果 1 行（同一幂等键，`completed`） | 通过 |
| 不换请求键绕过核对 | 恢复调用换了新的 provider call id，仍命中原效果行 | 通过 |
| 旧尝试复活后不能写 | 释放旧尝试后，它再次调用工具会被租约拒绝（AbortError），追踪记为 `refused`，没有额外写入 | 通过 |
| 已停止运行不被恢复 | 停止后伪造过期租约：对账器不选中，直接调用恢复也不启动新尝试，数据不变 | 通过（现有行为，无需修改） |
| 等待人工保持等待，有效回答才继续 | 伪造过期租约后对账器不选中；用其他 runId 回答返回 409；有效回答后恢复一次并写入一次 | 通过（现有行为，无需修改） |
| 不把不确定操作标记为确定 | 中断时工具结果 `uncertain: true`，追踪为 `ambiguous`；恢复后为 `completed`，尝试为 interrupted → completed | 通过（修复后） |
| 页面最终与数据库一致、保留尝试关系 | `runs/detail`（页面数据源）断言 Run completed，三次调用各自对应 attempt：旧尝试 `ambiguous`、恢复尝试 `completed`、旧尝试复活 `refused` | 通过（API 层） |
| 其他独立 Bot 不受阻 | 第一个 Run 卡住、仍持有租约时，同业务的风控 Bot 被派活并完成 | 通过 |

同一测试文件在修复前代码上失败（`red.log`、`red-final-test.log`），修复后在三个独立容器中均 4/4 通过。回归结果：PostgreSQL 7 个文件共 46 项通过（含 03 human-intervention、05 live-business-authorization、business-cycle、business-cycle-fixes、run-trace、run-effects）；adapters 单元测试 26 个文件共 742 项通过；adapters 类型检查及新测试文件的定向类型检查通过；Biome 检查通过（三个改动文件）。

## 页面

页面数据来自 02 的运行追踪：`TicketRuns` 已有逐个工具调用的状态，`ambiguous` 显示为“Result unknown”（02 已有单元测试覆盖）。本票不改 `apps/web`。据现有组件及 API 结果，各次尝试的工具调用平铺，恢复后的 Run 可能显示 “Result unknown · Done · Refused”，没有按尝试分组；最后的拒绝来自已失效的旧尝试。本轮没有实际页面复现。数据中保留了 `attemptId`，是否分组或标注旧尝试先由 Desktop 核实，确认问题后在 04 下交原 Claude 定向处理。

协调状态更正（2026-11-07）：02 已按 独立收尾报告（本地证据 `.scratch/etraderbot-foundation/acceptance/runs/close-02-20261107-b14fd8/report.md`，不在仓库中） 关票，不再处于验收中。本次展示疑点属于 04 恢复场景的待验收项；04 交接（本地证据 `.scratch/etraderbot-foundation/coordination/04-run-recovery.md`，不在仓库中） 不表示已向其他会话发送通知。其余测试结果及未验证范围保持原交付边界。

现有 e2e 夹具无法产生“已恢复的 Run”：需要故障注入，而 AGENTS.md 禁止往共享测试工具里加功能专用的故障钩子。因此本次没有页面截图，页面层仅验证到其 API。

## 未验证

- 真实进程被杀（本次用数据库连接终止加租约过期模拟“进程已死”）、Graphile 多进程部署下的跨进程恢复、真实模型重新发出同一调用的行为。恢复调用使用与 `run.continue` 作业处理器相同的租户上下文直接调用 `executor.continueRun`，没有经过真实作业队列投递。
- 浏览器中查看恢复后 Run 的页面、Electron、原生端。
- 其他写入工具在“提交后连接中断”时是否也会被报告为确定失败：本次只修复并验证了 `business_cycle`；`finish` 的修复对所有使用它的工具生效，但没有逐一测试。
- 现有设计允许显式的 `run.continue` 唤醒 `waiting_input` 的 Run（run-wakeup 已有测试断言这一点）。恢复对账不会这样做，本次也未改动；如有别的路径误投递，等待中的 Run 可能在没有回答时继续，这属于既有设计边界，未在本票处理。

## Desktop 验收步骤

1. 在本工作树运行：`pnpm exec tsx .scratch/etraderbot-foundation/04/recovery-20261107/run.mts packages/testkit/src/run-recovery.postgres.test.ts`。需要 Docker；会启动一次性容器，端口 3581 / 5651 只做预检。预期 4 项通过。
2. 可选回归：在同一命令后追加 `packages/testkit/src/human-intervention.postgres.test.ts packages/testkit/src/live-business-authorization.postgres.test.ts apps/api/src/business-cycle.postgres.test.ts apps/api/src/business-cycle-fixes.postgres.test.ts apps/api/src/run-trace.postgres.test.ts packages/adapters/src/run-effects.postgres.test.ts`，预期 7 个文件共 46 项通过。
3. 代码复核：`git diff packages/adapters/src/run-tools-trading.ts packages/adapters/src/run-tool-gate.ts`。注意前一个文件中 `expectedResultEvidenceId` 的透传来自 03，不属本次改动。
4. 对照上表逐条核对测试断言的层级：均为 API、PostgreSQL 与执行器层，没有浏览器。页面分组问题见“页面”一节，由原 Claude 会话或用户决定是否处理。

本会话不提交、不推送，也不启动 06、08、09。

## 第二轮：真实进程重启与等待边界（2026-11-07）

证据：`.scratch/etraderbot-foundation/04/restart-20261107/`（含 `snapshot.txt` 快照指纹）。本节替代上文“未验证”中关于“真实进程被杀”和“显式 `run.continue` 唤醒 `waiting_input`”两条。

### 真实进程重启（`packages/testkit/src/run-recovery-process.postgres.test.ts`，新增）

测试把真实 API 组合（HTTP、执行器、内存作业队列和恢复对账器）放进独立的 OS 子进程运行，子进程入口是 `packages/testkit/src/run-recovery-process.ts`（04 专用，未改共享测试工具）。

- 第一个进程执行尝试，测试用数据库行锁把它停在指定位置，然后用 `SIGKILL` 杀掉，或用 `SIGSTOP` 冻结。
- 随后启动一个全新的进程。测试不给它发任何唤醒，没有手动让租约过期，也没有同进程调用；它等原租约自然过期（5 分钟，与生产一致）后，自己通过对账器和作业队列找到并恢复这个 Run。

| 情形 | 结果 |
| --- | --- |
| 写入前被杀（停在业务事务内） | 新进程恢复原 Task／Run；同一幂等键的效果从 `intended` 变为 `completed`；业务证据 1 条、评论 1 条；工单 done |
| 业务已提交、记账未完成时被杀 | 被杀时业务证据已有 1 条、效果仍为 `intended`；新进程重新执行后由业务精确重放确认，最终仍只有 1 条证据和 1 条评论 |
| 进程冻结超过租约，恢复后继续 | 新进程完成并写入一次；冻结进程恢复后，再次提交同一结果被租约拒绝（AbortError），数据不变，追踪依次为 `completed`、`refused` |

三项在同一次运行中全部通过（3/3，约 936 秒），每个子进程的 pid 与输出都保留在证据目录。调试时发现一个真实的数据库行为：进程被杀时，它已发给数据库、正在等锁的语句，在锁释放后仍会提交，因为 Postgres 要到下一次向客户端写数据时才会发现客户端已断开。为了稳定构造“记账未完成”这一状态，测试在一次性数据库上设置了 `client_connection_check_interval`，并等死进程的语句被清掉后才释放锁。这是对测试环境的设置，不改产品代码。生产中，这个窗口内的结果可能是“记账已完成”，现有幂等机制同样覆盖这种情况。

恢复经过的是 `memory` 唤醒驱动下真实的作业队列：新进程的 `createJobReconciler` 把作业投递给 `InMemoryJobQueue`，再由 `run.continue` 处理器以 Run 所有者租户执行。生产默认的 Graphile 驱动（`apps/worker` 的 `RunWorkerHost` + Graphile）多进程投递仍未覆盖。

### 等待边界（缺陷与最小修复）

各入口的核对见证据目录中的 `waiting-entrypoints.md`。

- **允许继续的路径：** 只有有效人工回答（普通问题、选择、批准、凭据）。它们在同一事务里先把 Run 改为 `queued`，再投递作业。停止、新消息取代问题、卡住清理都会终止 Run，不会让它继续。
- **缺陷：** `executor.continueRun` 的认领条件、`RunJobPublisher` 的 `RESUMABLE` 和 `RunWorkerHost` 扫描都接受 `waiting_input`，因此任何迟到或重复的 `run.continue`（例如暂停前已排队的作业被重新投递）都能让等待中的 Run 在没有回答时继续执行到底。红灯中，该 Run 一直执行到 completed，并写入了业务结果。当前代码中没有任何入口需要在不改状态的情况下唤醒 `waiting_input`；带 `availableAt` 的唤醒只针对 `queued`。
- **修复：** `packages/adapters/src/executor.ts` 中 `continueRun` 的认领条件，以及 `packages/adapters/src/run-wakeup.ts` 中的 `RESUMABLE` 和扫描条件，都去掉 `waiting_input`。`waiting_takeover` 保持原语义（接管释放后显式唤醒）。`run-wakeup.postgres.test.ts` 中的旧断言使用的是不经过执行器的假处理器，不受影响，未改动。
- **测试：** `run-recovery.postgres.test.ts` 的等待用例补充两种投递：经 app 作业队列的迟到投递，以及另一 worker 的直接认领。两者都不会继续 Run，尝试次数保持 1；之后有效回答只让 Run 继续一次。

### 回归

- **PostgreSQL：** 12 个文件中 11 个通过，覆盖 04 两个文件、run-wakeup、03 human-intervention、05 live-business-authorization、computer-approval、history-clarification、journeys、business-cycle、business-cycle-fixes、run-trace、run-effects。`authorization.test.ts` 有 4 项失败，回退本次修复后同样失败，属于既有问题。
- **单元测试：** adapters 相关测试通过。`executor-turn-checkpoint.test.ts` 27 项全部失败，回退本次修复后也是 27 项失败，原因是既有夹具缺口（`Bot is unavailable in this workspace`）；这些用例在恢复前先把 Run 改为 `queued`，与新语义一致。
- **静态检查：** 类型检查和 Biome 通过。

### 仍未验证

- Graphile 多进程投递（`apps/worker`）。
- 真实模型、浏览器（04-D1 由原 Claude 负责）、Electron 与原生端、完整 CI。
- 除 `business_cycle` 以外的写入工具。

### Desktop 复测（最终快照）

1. 先等 04-D1 和 CLI 06 的相关交付稳定。冻结后用 `snapshot.txt` 中的文件哈希比对；HEAD 已在本会话期间变化，只比较 SHA 不够。
2. 进程重启：`pnpm exec tsx .scratch/etraderbot-foundation/04/restart-20261107/run.mts packages/testkit/src/run-recovery-process.postgres.test.ts`。约 16 分钟，需要 Docker；预期 3/3 通过。子进程日志位置可用 `RUN_RECOVERY_LOG_DIR=<绝对路径>` 指定。
3. 进程内 4 项（含等待边界）：`pnpm exec tsx .scratch/etraderbot-foundation/04/restart-20261107/run.mts packages/testkit/src/run-recovery.postgres.test.ts packages/adapters/src/run-wakeup.postgres.test.ts packages/testkit/src/human-intervention.postgres.test.ts`，预期 3 个文件共 21 项通过。
4. 代码复核：`git diff packages/adapters/src/executor.ts packages/adapters/src/run-wakeup.ts`。`executor.ts` 中 `toolTraceVersion` 一段来自 02，不属 04。
