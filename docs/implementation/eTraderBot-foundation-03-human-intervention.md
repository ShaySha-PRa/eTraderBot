# 03：人工等待、继续与停止

日期：2026-11-06。分支 `feat/platform-foundation`，代码基准 `de2b7967`。
代码和定向自动化回归已实施；浏览器验收待进行。按使用者要求，在其他会话仍进行浏览器验收时不启动第二轮浏览器测试。未提交或推送，没有启动 04。

## 行为与实现

- 普通问题及动作确认：在原消息记录回答者，回答与恢复状态在同一线程事务中提交。相同回答重发、并发或响应丢失后的重试返回原接受结果，不重复入队，不追加回答事件；不同回答、不同回答者、错误作用域不作为重放接受。刷新通过原线程消息重新定位问题。
- 停止：复用现有 `cancelled` 和 Run 租约，在每次工具入口以及可能等待的权限门禁之后重新核对运行资格。流式消息循环的缓存检查不能代替工具准入检查。已经发出的操作属于在途操作，停止不能撤回已提交的副作用；相关证据继续保留。
- 人工调查结果：仍调用原业务周期服务，不取消 Bot Run。原始证据版本、负责人、角色、依赖和完成条件继续检查；另增加结果版本比较，防止原始证据未变时，旧 Bot 结论覆盖新人工发现或未解决事项。
- 同一结果的重复提交只确认既有结果，不把专业 Bot 显式恢复的 `doing` 改回 `review`／`done`。明确基于最新结果提交新修订时追加证据；再次得到更早的结论也是新版本，旧证据不覆盖、不删除。
- Web／Electron 共用业务周期表单。草稿保留开始编辑时的证据及结果版本；刷新和提交期间继续输入均不能静默换用新版本。冲突显示在对应任务表单，保留文字，通过已有文案“Use latest version／使用最新版本”显式采用当前依据。普通回答失败沿用卡片内错误及输入保留行为。

没有新任务调度器或状态机，没有数据库结构迁移。主管、专业角色、算法启用和交易批准权限不变，工作区隔离继续由现有服务执行。Expo 的普通回答共用同一 RPC；业务周期写入继续使用 Web 入口，移动端保留现有只读降级。

凭据卡片不保存可比较的秘密或秘密摘要，保持已有的失败清空及重复提交保守拒绝行为；本票的成功重放范围为普通问题和非秘密动作确认。旧已回答消息若没有回答者收据，也不猜测其重放资格。旧历史可继续读取。

## 契约与客户端适配

| 接口/字段 | 含义及兼容方式 |
| --- | --- |
| `threads.answer` | 输入和成功响应仍为原契约，成功为 `{ ok: true }`；普通重复回答不再误报 409，内容冲突仍拒绝。 |
| ask 消息的 `answeredByUserId?: string` | 服务端写入的接受收据；旧消息字段缺失合法，不重写旧消息。 |
| 内部 `ThreadEvents.answerRunInput` | 返回 `true`、`false` 或 `"replayed"`；仅 `true` 触发立即入队，重放不重复通知或记批准审计。 |
| `BusinessWork.resultEvidenceId?: string \| null` | 当前任务最新结果证据 ID，包含已失效但保留的历史头；`null` 表示从未写入结果。新服务总是返回；字段缺失只用于兼容旧服务。 |
| `businessCycle.complete.expectedResultEvidenceId?: string \| null` | RPC 和 `business_cycle complete` 工具共同支持。发送读取任务时的 ID；首次提交发送 `null`。省略按 `null` 处理，仅兼容首次写入和完全相同的重试，不能无条件替换旧结果。 |
| 版本冲突 | 领域错误 `STALE_DATA`；RPC 保持既有 `BAD_REQUEST` 及 `data.reason`，工具返回原错误结构。先读取最新结果及未解决事项，再明确提交。 |

现有结果内容及旧哈希不改写。新修订的来源请求摘要绑定前一结果版本；完全相同的当前结果及依赖通过已有结果记录识别重试。版本核对、证据追加、任务结果和评论写入由原业务周期锁与事务协调。

## 改动文件

| 范围 | 文件 |
| --- | --- |
| 回答收据、恢复入队 | `packages/contracts/src/events.ts`、`packages/db/src/events.ts`、`apps/api/src/routes/threads.ts` |
| 工具停止准入 | `packages/adapters/src/run-tools.ts` |
| 业务结果版本与历史 | `packages/contracts/src/business-cycle.ts`、`packages/db/src/business-cycle-work.ts`、`packages/db/src/business-cycle.ts`、`apps/api/src/routes/business-cycle.ts`、`packages/adapters/src/run-tools-trading.ts`、`packages/adapters/src/builtin-tools.ts` |
| 业务草稿与冲突交互 | `apps/web/src/pages/BusinessCycle.tsx` |
| 回归 | `packages/testkit/src/human-intervention.postgres.test.ts`、`apps/api/src/business-cycle-fixes.postgres.test.ts`、`apps/api/src/business-cycle.postgres.test.ts`、`packages/db/src/events.test.ts`、`packages/adapters/src/run-tools.test.ts`、`apps/web/src/components/AskCard.test.tsx`、`apps/web/src/pages/BusinessCycle.test.tsx` |

另更新本记录和 03 的本地任务票／协调记录；01 启动保护、07 经验交接及其语言目录不属于本票改动。

## 验证

全部数据库回归由现有 Testcontainers 流程创建独立 PostgreSQL；HTTP／executor 样本使用临时文件目录、合成账号、确定性运行时和 FakeSandbox。API/Web 测试端口为 3521/5591；早期另一独立数据库套件使用 3531/5601。没有将原业务库、原附件、Desktop 验收库用作测试目标。

- `API_PORT=3521 WEB_PORT=5591 pnpm test:integration --spec=human-intervention`：3 项通过。认证 HTTP、真实队列和 executor 的回答并发/重试只交付一次、写文件一次；覆盖等待后停止、已发出写入与停止后下一工具的竞争。
- `API_PORT=3521 WEB_PORT=5591 pnpm test:integration --spec=business-cycle`：17 项通过，包含结果版本竞争、人工录入不取消模拟运行中的 Run、重放不回退调查状态、历史保留、跨业务/角色拒绝及 P25 原结果 23,700 元、82 MWh 更正后 24,320 元。
- `API_PORT=3521 WEB_PORT=5591 pnpm test:integration --spec=executor-lifecycle`：24 项通过。
- 定向单元：事件、工具分发、运行时取消、回答卡片、业务表单、聊天提交及移动回答，共 217 项通过。
- contracts、db、adapters、API、Web 的 TypeScript 检查通过；移动端直接 `tsc` 通过。新增 PostgreSQL 测试的独立 TypeScript 检查通过。

上述通过的命令退出码均为 0。定向单元和类型检查命令：

```sh
pnpm exec vitest run packages/db/src/events.test.ts packages/adapters/src/run-tools.test.ts packages/adapters/src/pi-runtime-cancellation.test.ts apps/web/src/components/AskCard.test.tsx apps/web/src/pages/BusinessCycle.test.tsx apps/web/src/pages/shell/use-composer-actions.test.tsx apps/mobile/lib/thread-answer.test.ts
pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/web check
pnpm exec tsc --noEmit -p apps/mobile/tsconfig.json
pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/03/tsconfig-focused.json
```

回归前已分别复现重复回答 409、停止后只读工具仍执行、旧 Bot 结果覆盖人工发现、重复结果回退 doing、A→B→A 历史冲突及表单刷新偷换草稿依据。修复后保留对应断言。仅对本票 18 个代码文件运行 Biome，`git diff --check` 通过；未进行全仓格式化。

扩展检查存在以下限制，不能算作全部检查通过：

1. testkit 整包类型检查仍在未修改的 `authorization.test.ts:238` 报 `TS2345`；新增文件独立检查通过。
2. 移动端标准 `check` 先运行 Expo 依赖版本核对，该步骤因现有依赖版本差异退出；没有升级依赖或锁文件。直接 TypeScript 检查不能替代原生验收。
3. 额外运行的 `bot-secrets` 数据库套件有 2 项失败：测试期待 `spaceId: null` 的账号级凭据，实际保存为工作区级凭据。本票未修改该测试及凭据存储逻辑，也未通过放宽工作区隔离使它通过。未对这一测试期望差异进行完整修复或整基线重跑。
4. 未运行浏览器、Electron、原生设备、全仓 CI、真实模型和真实外部操作验证。确定性运行夹具不证明模型的任务理解或协作质量。

## Desktop 定向复测

等待其他会话浏览器验收结束，再用现有隔离浏览器测试环境或单独测试库执行；不要覆盖 01/07 的验收数据或原业务。使用合成资料。记录当前 SHA、工作树修改、Run/任务/消息 ID、结果版本、截图及请求响应。

1. 在 Bot 聊天发出可触发确定性人工问题的请求，例如 `Ask me which city to use`。等待人工后刷新，确认原消息和原 Run 仍在；填写普通答案，阻断一次回答请求检查输入与卡片内错误。再让服务已接受但客户端丢失响应，重发同一答案，核对只接受一次、一次恢复且无重复动作。
2. 在等待中停止，刷新后确认已停止；再次调用旧问题的回答接口应拒绝。对运行中的测试任务停止，不能继续开始后续工具；已经发出的模拟写入仍保留。精确竞态以隔离 executor 回归为证，不用人工点击时序替代。
3. 打开合成业务的业务周期，派发合同覆盖或结算调查。保留专业 Bot 的运行；人工录入带未解决事项的结果，确认 Run 未被取消，工单处于 review。专业 Bot 可显式继续调查为 doing，但不能直接跳过证据提交完成。
4. 两个标签页同时编辑同一任务。甲先录入新发现，乙保留原草稿。乙提交应得到版本冲突，草稿不丢；确认最新发现后用“使用最新版本”再提交。核对旧结果仍在历史中，新的未解决事项不会被迟到提交静默清除。
5. 重发甲原先成功的同一请求，不能把已经继续调查的工单倒退回 review。用相同预期版本同时提交两份不同结果，只能有一份新修订。
6. P25 复盘先核对 80 MWh／23,700 元，再更正为 82 MWh／24,320 元；原证据引用和历史保留。上述金额均为教学模拟电能量结算，不是净利润。
7. 对普通问题和冲突表单做中文、英文及窄屏检查。凭据错误信息不能回显秘密，凭据输入继续遵守原有清空行为。适用原生入口另行验证。

## 前端复核（Claude，2026-11-06）

依据 Desktop 定向验收报告中“服务端已接受回答，但响应被替换为纯文本 502 后卡片残留解析错误”的发现。只改 Web 前端、翻译及测试；不改共享契约、服务端、数据库或移动端。

### 行为

- 回答卡片只保存失败本身（操作和原因），渲染时再生成文案，所以切换界面语言后错误随之改变；不再显示客户端或服务端的原始英文文本。
- 回答或拒绝操作失败后，如果实时更新显示该问题已被服务端接受，只清除该回答操作的旧错误；撤销操作的错误不受影响。
- 普通回答未被接受时保留输入和错误：无法连接服务器显示“无法连接服务器”，服务端拒绝（CONFLICT）显示“该问题已不再等待回答”，其他失败显示“无法提交此回答”。
- 凭据和登录卡片保持原样：提交前清空输入，失败时只显示通用的“无法提交此回答”，不回显秘密或服务端文本。
- 业务周期任务表单的错误同样只存原因，渲染时翻译；结果冲突的“使用最新版本”和草稿依据保持 03 原有实现。
- 新增文案 1 条：`This question is no longer waiting for an answer`（zh-CN“该问题已不再等待回答”，zh-TW“此問題已不再等待回答”）。服务端拒绝时用户需要知道重试无效，通用失败文案会误导重试。提取命令仅新增该条目。

### 验证

- 单元：`AskCard.test.tsx` 36 项、`BusinessCycle.test.tsx` 16 项通过；新增的回答卡片用例在修复前的实现上失败。Web 全部单元 184 个文件 1754 项通过；`@rakazo/web check` 通过。
- 隔离 Playwright（Testcontainers 新库，`API_PORT=3310 WEB_PORT=5380`，确定性脚本运行时）：
  - `e2e/ask-card-answer-failure.spec.ts`：390×844 下实测 `innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`。依次覆盖服务端拒绝（英文→中文切换，输入保留、不显示原始文本）、请求未送达（中文，输入保留）、服务端已接受但响应被替换为纯文本 502（上游只接受一次，卡片显示答案、错误消失、运行只恢复一次）。
  - `e2e/business-cycle-drafts.spec.ts` 新增用例：中文 390 CSS px（同上实测），他人先提交结果后旧草稿提交被拒绝，提示随语言切换，草稿保留，服务端结果未被覆盖；“使用最新版本”后重新提交成功。同文件既有用例补上 03 新增的 `expectedResultEvidenceId: null` 请求字段预期。
  - 两个 spec 共 5 项通过。
- 截图：`.scratch/etraderbot-foundation/evidence/03-answer-and-conflict/`（refused en/zh、unreachable zh、accepted zh/en、结果冲突与重新提交 zh）。

### 限制

- 502 响应丢失由 Playwright 路由在上游成功后替换回复模拟，不代表真实网络断链的所有时序。服务端拒绝用例的 409 是路由合成的，真实旧问题 409 已由集成测试和 Desktop 直接 HTTP 验证。
- 凭据卡片失败与清空由单元测试和既有 `secret-card.spec.ts` 覆盖，本轮未重跑该 spec。
- 未运行 Electron、原生移动端、真实模型；问题正文由脚本生成，为英文。


## 后端补证（CLI，2026-11-06）

Desktop 提出的严格结果竞争、秘密回答重复提交拒绝已完成，详见 [03 后端补证记录](eTraderBot-foundation-03-backend-evidence.md)。新增真实 PostgreSQL 行锁屏障确认两个事务重叠；API key 和 login 多字段的相同已接受回答重发均为 409/CONFLICT，不重复保存或恢复。两份相关测试文件共 20 项通过，API 与聚焦测试类型检查通过。只改测试及交付记录，没有产品修复或前端修改。

原 Desktop 报告及审计保留；本次证据为 service/进程内 RPC 和认证 HTTP/executor 分层回归，不算浏览器或真实模型验收。03 仍待 Desktop 最终复核，原有整包类型、Expo 版本及其他凭据套件限制继续保留。未提交推送、未启动下一票。
