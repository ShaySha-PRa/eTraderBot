# 06：更换 Bot 后接续未完成工作（后端交付）

2026-11-07。工作树 `platform-foundation`，分支 `feat/platform-foundation`。开始 HEAD 为 `de2b7967c2b7353d621b31ffce4ee44bc0fed4c1`；实施期间另一个会话提交了 01 启动保护，核对时 HEAD 为 `a6cf2bd9cc8b7cce1fbb438ed1e874337f702c5c`。该提交及全部其他修改均保留，本会话没有执行提交、推送、reset 或 clean。

**后端及隔离自动化已交付，任务保持 in-progress，等待原 Claude 前端接续与 Desktop 独立验收。** 本票不依赖 04 完成验收。前端交接文件：`.scratch/etraderbot-foundation/coordination/06-bot-replacement.md`，需要使用者转交；没有其他会话接收回执。

## 交付行为

1. Bot 归档共用路径取消原有运行后，使用现有业务周期协调服务标记未完成工单因负责人归档而阻塞，清除其待派发标记，保留已有结果、证据、引用和评论。通过原 board ticket-change 通知刷新，不触发新运行。已完成历史仍保留作者和结果。
2. 新增只读恢复资料接口，返回服务端确认的负责人状态与候选。普通工单恢复仍使用原 `tickets.update`，不建立新任务框架、恢复写接口或调度器。
3. 负责人恢复继续锁定原周期，复用 05 的当前身份检查和授权行锁；同时锁定原负责人状态、复核替代者身份。只允许缺失或归档负责人被同业务、同用户、同专业的有效 Bot 替代；主管不是专业替代者。人工或本业务主管可以发起恢复，专业 Bot 不能自行转移负责人。
4. 重复同一恢复请求不重置已消费的派发资格。两个不同替代者竞争时，后取得周期锁的一方看到新的有效负责人并被拒绝。工单和周期 ID 不变；需要运行时创建独立的新 Task/Run，沿用原 ticketId 关联，原 Bot 的聊天和旧 Run 不转给新 Bot。
5. 新 Task 的提示携带数据库中的原 cycleId，要求先读最新业务证据、历史复盘及未解决事项，再按当前结果版本提交。即使可编辑工单描述改变，周期关联仍由持久化关系提供。未解决事项不会因替换而自动完成；有前序资料依赖的任务继续阻塞，证据到齐才唤醒新负责人。
6. 替换只改变负责人和派发资格，不复制凭据、授权、算法批准、聊天、计划或电脑文件。原 Bot 恢复有效身份后也不重新取得该工单负责人资格；业务结果写入仍执行 05 的当前负责人检查。

归档的业务状态协调在原归档事务提交后进行，避免与 05 的“先周期锁、后身份锁”形成反向锁序。归档状态本身已经使旧 Bot 失去运行及写入资格；若后续状态通知因中断丢失，页面仍需使用已有轮询 / 重连重读兜底。这不是持久化通知 outbox 或跨进程广播保证。

## 共享接口

新增 `businessCycle.recovery({ ticketId })`，HTTP 路径 `/rpc/businessCycle/recovery`。输出：

```ts
{
  ticketId: string;
  cycleId: string;
  requiredRole: "mid_long_term" | "spot" | "risk" | "review";
  assignee: { id: string; name: string; archivedAt: string | null } | null;
  canReplace: boolean;
  candidates: Array<{ id: string; name: string }>;
}
```

- `assignee=null` 明确表示未分配或已删除；非空且 `archivedAt=null` 为当前有效负责人，否则为 ISO 归档时间。不能用过滤后的前端 roster 缺项推断归档。
- `canReplace=false` 时 `candidates=[]`。可恢复但尚无合格 Bot 时也可为空，前端不能提交空选择；先创建同专业 Bot 再刷新。
- 候选仅代表读取时状态。提交仍通过 `tickets.update({id:ticketId,assigneeBotId})` 重新检查；列表返回后归档该候选会导致提交拒绝。
- 原 API 允许修复已完成工单的缺失 / 归档负责人，仍不新增执行工作，也不改已完成结果；06 的主要页面验收针对未完成工单。
- 不可见周期工单为 `NOT_FOUND`；恢复的领域拒绝映射为 RPC `FORBIDDEN`、`data.reason=FORBIDDEN`；其他领域校验为 `BAD_REQUEST` 并携带原原因。未知 / 跨业务 / 已归档目标可能由现有 Bot 查找提前返回 `NOT_FOUND`。工作区成员资格已撤销仍按 05 返回 HTTP 401。
- 原 `tickets.update` 输入、Bot `ticket_update` 入口和 `business_cycle complete` 字段保持兼容。没有新增交易权，也未改变 `expectedResultEvidenceId`、完全相同结果重放或人工批准语义。
- `businessCycle.get` 的阻塞列表新增 `assignee:archived`；保留已有 `assignee:missing`。字段结构没有变化。

## 修改文件

| 文件 | 本轮范围 |
| --- | --- |
| `packages/contracts/src/business-cycle.ts` | `BusinessRecoverySchema` 和只读 recovery RPC |
| `packages/db/src/business-cycle.ts` | recovery 领域查询；原 complete 与 05 修复保持 |
| `packages/db/src/business-cycle-work.ts` | 归档阻塞资料、归档协调与通知、恢复时复用当前身份锁 |
| `packages/db/src/index.ts` | 导出共用归档协调函数 |
| `packages/adapters/src/child-bots.ts` | 交易 Bot 归档后协调原工单，复用可选通知依赖 |
| `packages/adapters/src/ticket-wake.ts` | 新 Task 携带可靠 cycleId，并要求读取当前证据；原领取和队列机制不变 |
| `apps/api/src/routes/bots.ts` | 向共用归档路径传入既有 ticket notifier |
| `apps/api/src/routes/business-cycle.ts` | recovery 路由，沿用身份及错误映射 |
| `apps/api/src/routes/boards.ts` | tickets.update 的领域拒绝映射为可识别错误 |
| `packages/testkit/src/bot-replacement.postgres.test.ts` | 7 项隔离 HTTP / PostgreSQL / executor 回归 |

没有迁移或业务数据修补。既有其他票改动不归入本轮；没有修改前端、执行器、租约恢复或 04 的工具效果处理。修改前已在 06 协调文件登记共享模块范围。

## 实施方验证

证据目录：`.scratch/etraderbot-foundation/06/backend-20261107/`。`run.mts` 复用仓库 Testcontainers / process helpers，覆盖数据库 URL、使用独立容器和每文件测试库、临时数据目录；端口预检 3591 / 5661，HTTP 在进程内，不监听或重启 Desktop 服务。结束只清理本轮容器与临时目录。

新增 7 项覆盖：

- 真实认证 `bots/archive` 后的阻塞状态、旧结果 / 评论不变、既有看板 topic 通知、不新增运行。同一周期中的已完成工单仍为 done，保留结果版本及作者，完成和启动阻塞资料均不因作者归档新增负责人阻塞。修复前 `archive-red.log` 因未完成工单仍为 review 失败；修复后通过。
- 服务端候选和确认拒绝覆盖主管、错误专业、已归档、同用户另一业务、另一用户另一业务；候选返回后被归档也不能提交。重复恢复和缺失负责人 null 语义。
- 原 Bot 正在实际 executor 中运行并已通过工具提交未完成结果；正常归档后，旧 Run 被取消。正常 HTTP 恢复和原队列唤醒新 Bot，实际工具读取原结果 / 未解决事项，并追加 review、done 两个新版本；旧证据及来源作者保留。旧 Run 的迟到工具调用记录为 `refused`；恢复原 Bot 后直接结果提交仍拒绝。
- `identical` / `different` 两项严格竞争：独立 PostgreSQL 事务锁住原周期，观察两个不同请求连接在同一锁链上等待才释放。相同恢复两份成功但仅一条新 Run；不同候选恰一份成功、另一份 403；不只是 `Promise.all` 同时发请求。
- 使用真实模拟交易服务准备算法版本、交易意图、人工批准和仅属于原 Bot 的范围授权，另存合成加密 Bot 凭据。恢复前后凭据、版本、意图、授权、角色绑定逐项不变。替代者仍分别遭遇 `ALGORITHM_NOT_APPROVED`、`TRADE_NOT_APPROVED`、`GRANT_MISMATCH`、`BOT_MISMATCH`，没有生成模拟执行。算法批准本来属于业务场景版本，已对目标开放的同业务版本仍可用；本测试不把共享场景批准误称为原 Bot 私有批准。
- 有前序任务依赖的现货工单替换后仍阻塞、零 Run；前序有据结果完成后只唤醒新 Bot 一次，重复结果确认不再次派发。

执行记录：

| 检查 / 日志 | 结果 |
| --- | --- |
| `run.mts packages/testkit/src/bot-replacement.postgres.test.ts apps/api/src/business-cycle-fixes.postgres.test.ts apps/api/src/business-cycle.postgres.test.ts packages/testkit/src/live-business-authorization.postgres.test.ts packages/testkit/src/run-recovery.postgres.test.ts apps/api/src/workspace-isolation.postgres.test.ts`；`postgres-final.log` | 6 文件、44 项通过，退出 0；包括 04、05、P25 23,700 元及更正后 24,320 元、历史和角色隔离 |
| 新增测试中 `control.desk` 参数改为正确的 `{deskId}` 后，定向重跑凭据 / 授权一项；`permissions-final.log` | 1 通过、6 未选中，退出 0；未选中项不是新增通过数 |
| 补充已完成历史不受负责人归档影响的断言后，重跑上方同一组 6 文件；`postgres-completed-history.log` | 最终 44 项通过，退出 0；包含测试参数修正与完成历史检查 |
| `pnpm exec vitest run packages/adapters/src/child-bots.test.ts packages/adapters/src/ticket-tools.test.ts packages/adapters/src/ticket-wake.test.ts packages/core/src/trading`；`unit-first.log` | 6 文件、114 项通过，退出 0 |
| `pnpm --filter @rakazo/contracts check`、`@rakazo/db check`、`@rakazo/api check`、`@rakazo/adapters check` | 均通过，退出 0；对应 `types-contracts.log`、`db-first.log`、`api-first.log`、`adapters-first.log` |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/06/backend-20261107/tsconfig.json` | 新测试及依赖的聚焦类型检查通过，退出 0，`types-testkit-final.log`；初次发现测试参数 TS2345，已修正，`types-testkit.log` 保留失败记录 |
| 最后补充完成历史检查后，再跑 db 和上述聚焦测试类型检查 | 通过，退出 0；`db-completed-history.log` / `types-testkit-completed-history.log` |
| 本轮 10 个 TS 文件 Biome、`git diff --check` | 通过，`biome-final.log` / `diff-check.log` |

没有全仓格式化。开始快照记录了 Web、Desktop 既有验收文件及 04 三个实现 / 测试文件共 793 个校验值。最终对照发现并行会话更新了 32 个文件（Web 源码 / 翻译、浏览器测试产物、04 的 `run-recovery.postgres.test.ts`），均未覆盖；Desktop 的 `acceptance/` 目录没有差异，04 两个运行时实现文件未变，见 `protected-comparison.json`。04 测试文件的最终修改时间早于 `postgres-completed-history.log` 的运行，最终 44 项已包含该版测试。期间其他会话的 01 提交保留；未把并行状态变化误认为需要回退的改动。

## 前端与 Desktop 接续

请使用者把 `.scratch/etraderbot-foundation/coordination/06-bot-replacement.md` 转交原 Claude。前端还需消费 recovery 契约、订阅刷新并完成页面操作验证；本轮未修改现有页面，也未假设对方已收到。

Desktop 在前端交付后，用独立验收库和端口：

1. 在交易业务创建中长期 Bot、另一个同专业 Bot 及不匹配角色。载入 P25，派发合同覆盖，记录带未解决事项的结果；保存 ticketId、cycleId、原结果版本与来源。
2. 从 Bot 资料等另一入口归档原负责人。无需手动重载，工单应显示归档 / 阻塞，提供服务端允许的候选；完成刷新通知丢失后的轮询 / 重连兜底核对。
3. 选择同专业有效 Bot 恢复，确认原工单和周期不变。重复操作不得产生第二条替代 Run；活动旧负责人、主管、跨业务或已归档候选不能绕过后端确认。
4. 对照旧结果、引用、未解决事项、评论及 Run 关联。新 Bot 应读取最新证据后继续；历史作者仍是原 Bot，替换不是自动完成、审批或凭据交接。旧 Bot 恢复后不能写该工单结果。
5. 再验证缺少前序结果的工单：替换后仍阻塞，资料到齐后才创建新 Run；保留 05 草稿和结果版本冲突行为。
6. 核对后端严格竞争、权限和实际工具记录的证据层级，不把页面点击替代数据库竞态，也不把脚本运行时的结构化断言当作真实模型协作质量。

未验证浏览器、Electron、原生设备、真实模型、真实外部接口、Graphile 多进程广播或全仓 CI。Web / Electron 共用页面由原 Claude 接续；移动端仍沿用周期只读页面和现有聊天工具，本票不新增原生负责人编辑界面或自动历史迁移机制。任务不由本会话关闭，未启动下一票。
