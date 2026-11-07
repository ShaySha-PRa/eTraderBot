# 03：Desktop 缺口的后端补证

2026-11-06；工作树 `platform-foundation`，分支 `feat/platform-foundation`，HEAD `de2b7967c2b7353d621b31ffce4ee44bc0fed4c1` 加已有未提交修改。依据 `.scratch/etraderbot-foundation/coordination/03-desktop-evidence-supplement.md` 补测，**两项后端缺口已交付，03 整票仍待 Desktop 复核**。

仅修改两个测试文件及交付记录。没有发现本轮需要修复的产品缺陷，没有改生产逻辑、共享契约、AskCard 或其他前端文件；未提交、推送或启动下一票。

## 严格结果竞争

位置：`apps/api/src/business-cycle-fixes.postgres.test.ts`，用例 `03 supplement: overlapping result transactions append exactly one revision and reject the stale contender`。

先通过现有业务服务创建合成业务、派单，并经进程内 RPC 记录带未解决事项的初始结果。另开 PostgreSQL 事务，对该业务周期行执行 `SELECT ... FOR UPDATE`；这正是 `complete` 经 `ownedCycle(..., true)` 在读取结果头、比较预期版本和追加证据前使用的锁。

在屏障未释放时，同时发出受派专业 Bot 的真实 service 调用与人工进程内 RPC 调用，两者携带同一 `expectedResultEvidenceId`、不同的新结果。测试查询 `pg_stat_activity` 和 `pg_blocking_pids`，沿阻塞链确认 **两个不同后端连接均在同一锁链上等待周期行锁**，且业务状态及 Task/Run/评论/作业数量尚未变化，才释放屏障。不是仅以 `Promise.allSettled` 发起请求或用固定睡眠猜测重叠；没有生产测试钩子、模拟锁或替换事务。

释放后断言：

- 恰一份成功、另一份拒绝。Bot service 失败为 `STALE_DATA`；人工 RPC 失败为 `BAD_REQUEST` 且 `data.reason=STALE_DATA`，根据实际败方核对。
- 只追加一个 revision 2，`supersedesId` 指向原结果；当前任务精确采用胜方的结果及未解决事项，状态仍为 review。
- 原全部证据逐条保留，原结果中的未解决事项不变；评论只增加一条，Task、Run 和作业数量不增加。
- 屏障及竞争请求均在 finally 中释放/等待，断言失败也不留下占锁事务。

证据层级是 **真实 PostgreSQL 事务竞争 + 业务服务 + 进程内 ORPC**。测试证明请求在真实串行化边界重叠并正确冲突；锁内的检查/写入按设计串行，不宣称两次修改同时进入受保护区。未经过真实 Bot executor、模型或双浏览器提交。

## 秘密回答完全相同重发

位置：`packages/testkit/src/human-intervention.postgres.test.ts`，参数化用例 `03 supplement: accepted $kind secret answers reject identical replay without saving or waking twice`，分别覆盖 bearer API key 和 login 多字段。

通过认证 HTTP 的 `threads/send`、现有 ScriptedAgentRuntime 和真实 executor 生成受保护卡片，再以 `threads/answer` 保存合成凭据。首个请求成功后等待真实内存队列空闲，确认原 Run 完成，再同时重发两份与已接受输入完全相同的请求，包含原 `clientNonce` 和原 login fields。

明确断言：

- 首次返回 `{ok:true}`；两次重发均为 HTTP 409、ORPC `CONFLICT`，错误为 `This prompt is no longer awaiting an answer`，不回显合成秘密。
- Run 只有初始及恢复两个 Attempt；观察原队列的实际 enqueue，不替换实现：首次回答只发布一次 run.continue，重复回答不新增任何作业。
- 只保存一份当前工作区的 VaultCredential，密文为现有 v2 格式。重发前后完整比较凭据密文/时间戳、BotSecret、run-only Secret、Run/Task、Attempt、消息、事件和外部效果；所有持久化状态不变，Task/Run 数量不变。
- 卡片已回答但 `answer` 为空，只有一次消息更新事件；request_secret 效果已完成。凭据明文及登录账号均不进入可读取的运行/消息/事件历史。

测试没有为识别重放新增秘密明文、比较摘要或新收据。按实际契约检查工作区级凭据，没有沿用旧 `bot-secrets` 套件的账号级存储假设。

证据层级是 **认证的进程内 HTTP handler + PostgreSQL + 原内存队列 + 真实 executor + Scripted/FakeSandbox**。重复请求发生于首次保存和恢复完成之后；不等同于浏览器双击、响应丢失重试或所有回答/停止竞态。AskCard 失败清空与不回显仍由 Claude 的前端证据及 Desktop 复测负责。

## 环境、命令与结果

复用仓库 `startPostgres`、`runProcess` 和 `pin-test-env`。本地证据驱动脚本位于 `.scratch/etraderbot-foundation/03/backend-supplement-20261106/run.mts`，每次创建一次性 Testcontainers PostgreSQL，以已有迁移初始化，再由原测试环境为每个文件复制独立数据库。使用独立临时数据目录并在结束时清理自己的容器/目录；未修改公共测试框架。

开始前实际 bind 检查 3561/5631 空闲；HTTP 用进程内 `app.request`，没有监听开发或 Desktop 端口。驱动脚本避免覆盖共享 `test-report/integration`，日志保存在本轮独立证据目录。未操作 Desktop 的 16433/16443/16453/16463 服务、原业务库、附件或验收数据库。

| 验证 | 结果 |
| --- | --- |
| 单独运行严格竞争用例 | 1 通过、13 跳过，exit 0。 |
| 单独运行秘密重发用例 | 2 通过、4 跳过，exit 0。 |
| 两个相关文件全部回归 | 2 文件、20 项通过，无跳过，exit 0；包括既有 03 结果保护、02 追踪和该文件中的 P25 更正回归。 |
| API 类型检查 | 通过，exit 0。 |
| 聚焦 HTTP 测试类型检查 | 首次发现测试 spy 的类型声明错误（TS2344，exit 1）；改用 Vitest 的 MockInstance 类型后通过，exit 0。未涉及产品修复。 |
| Biome / diff | 仅两个修改的代码文件检查通过，`git diff --check` 通过。 |

精确命令（从工作树根目录执行）：

```sh
pnpm exec tsx .scratch/etraderbot-foundation/03/backend-supplement-20261106/run.mts apps/api/src/business-cycle-fixes.postgres.test.ts -t '03 supplement'
pnpm exec tsx .scratch/etraderbot-foundation/03/backend-supplement-20261106/run.mts packages/testkit/src/human-intervention.postgres.test.ts -t '03 supplement'
pnpm exec tsx .scratch/etraderbot-foundation/03/backend-supplement-20261106/run.mts apps/api/src/business-cycle-fixes.postgres.test.ts packages/testkit/src/human-intervention.postgres.test.ts
pnpm --filter @rakazo/api check
pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/03/tsconfig-focused.json
pnpm exec biome check apps/api/src/business-cycle-fixes.postgres.test.ts packages/testkit/src/human-intervention.postgres.test.ts
git diff --check
```

证据目录保留 `strict-first.log`、`secret-first.log`、`regression.log`、类型检查初次失败与最终通过日志，以及 `protected-before.json` / `protected-after.json`。AskCard 源码/测试和 Desktop 原 03 验收目录共 12 个文件校验值未变。未改写 Desktop 原浏览器报告或静态审计。

## 剩余缺口与 Desktop 交接

- Desktop 核对这两项新增断言及运行记录即可，不必用人工点击制造严格数据库竞态，也不据此把浏览器场景勾为通过。
- Claude 的 AskCard 页面交付、实际 390 CSS px、错误恢复和凭据页面由 Desktop 另行复测；本轮未启动浏览器。
- 未验证真实模型、真实接口、Electron、原生设备、Graphile 多实例恢复或全仓 CI。既有 testkit 整包 TS2345、Expo 依赖核对及旧 bot-secrets 两项失败未在本轮重跑或解决，沿用原记录的限制。
- 本轮补证不解除 03 整票验收前置；04、09 及其他下一票未启动。
