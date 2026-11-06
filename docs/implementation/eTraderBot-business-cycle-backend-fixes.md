# 业务周期后端修复记录

本轮仅负责 contracts/core/db/adapters/API 与对应测试；前端及浏览器修复由另一会话负责。沿用 `feat/etraderbot-v1`、`998c6bae` 和全部已有未提交实现，不提交、不推送，不修改开发业务库。

## 前端契约同步

以下为本轮修复采用的兼容口径：

- `BusinessWork.assigneeBotId` 接受 `string | null`，与现有 Ticket 一致；空值表示原负责人已删除，历史结果仍保留。
- 原 `requiredEvidence`、`blockers` 继续表示**完成**所需资料及缺口；新增可选 `startBlockers?: string[]` 表示**开始处理**的缺口。旧客户端可忽略新字段；新客户端可用 `startBlockers ?? blockers` 展示启动状态，不能用启动就绪推导完成就绪。
- 周期 `reviewReady` 和顶层 `blockers` 保持“可完成复盘”的含义。结算未生成或账单有差异时，任务可以运行核对，但尚不能完成。
- 计量更正后原始资料已齐全时，复盘状态由旧实现的 `blocked` 改为 `todo`，`startBlockers=[]`，而 `blockers` 仍含 `evidence:settlement`、`reviewReady=false`，等待已入队的复盘生成新试算。原始计量／账单暂估也允许开始调查，但只有关键资料和试算均确认后才允许无未解决事项地完成；提交含 `unresolved` 的调查结果保留为 `review`。
- 日前申报保持 `streamKey="submission"`；其他阶段新增 `submission:<stage>`。原始历史 RPC 不改写旧证据；共享 `latestBusinessEvidence/currentBusinessEvidence` 对旧混合流按 `data.stage` 做读取投影，证据 ID、原始版本及内容摘要不改写。前端应按 `kind="submission"` 识别证据类型，不以单个流代表所有阶段。
- 恢复缺失负责人复用现有 `tickets.update({ id, assigneeBotId })`／`ticket_update`，无新增 RPC。新负责人必须为同业务、同所有者、未归档且符合任务专业角色的 Bot；仅人类或业务主管可以恢复，不转移任何交易批准或授权。

## 测试资源与当前状态

PostgreSQL 测试使用现有 `test:integration`、独立临时容器与按文件复制的数据库；指定非 E2E 默认 API/Web 端口，不访问开发数据库。输出为 `test-report/integration`，不运行或修改前端 E2E、截图目录及配置。

本轮已完成 R1、S1、S2、S3、R2 的后端实现及定向回归。先运行审查最小复现脚本确认 R1/S1/S2/R2，再在真实 PostgreSQL 测试中分别观察失败：R1 两个方向重报获准；S1 没有 Run 却消耗派单标记；S2 删除负责人后 Zod 解析失败；S3 阻塞任务创建没有通知；R2 已齐原始资料仍不能入队。修复后这些用例全部通过。历史验收数量不计入本轮通过数。

## 对应修复

| 项 | 实际修改 | 回归证据 |
| --- | --- | --- |
| R1 | 封存检查覆盖该周期的全部阶段历史；新的非日前申报独立成流。旧混合流按阶段读取，原文不迁移；同一执行和回执序号先检查既有记录与内容，再追加，重复调用不产生新版本。 | 中长期→日前→中长期、日前→中长期→日前均拒绝准备及预先准备好的第二意图执行；重复执行请求、旧阶段回执推进和旧回执重试不遮蔽封存。旧混合流及新流接续的读取投影另有单元测试。 |
| S1 | 先确认有效 Ticket、可运行 Bot 和会话，再领取；领取与 Task/Run 创建仍在一个事务内。持锁后复核任务当前负责人／终态。恢复交易 Bot 调用同一周期协调器和通知器，重复恢复幂等；原 job reconciler 继续恢复已创建但未成功发布的 Run。 | 阻塞→归档负责人→前序完成时派发标记仍为 false，且无负责人 Run；恢复后恰好创建一个 Task/Run，重复／并发恢复及再次唤醒不重复入队。 |
| S2 | 可空负责人不再阻止周期读取。只允许所有者或业务主管替换缺失／归档的负责人；重新校验工作区、成员、所有者、电脑归属、有效身份及专业角色。重新分配不复制批准或授权。先协调阻塞状态，再唤醒；已完成任务不因负责人恢复而失效或重跑。 | 真正删除测试 Bot 后，未完成及已完成任务均可读；旧复盘证据逐字段相同。拒绝跨业务、错误角色、主管作为专业负责人、归档 Bot 和专业 Bot 擅自恢复；所有者／主管成功恢复，未完成任务回到 todo 并仅入队一次，已完成任务不增加运行。 |
| S3 | `reconcileBusinessWork` 接受可选的显式变更 Ticket ID，将状态通知与执行唤醒分开。创建阻塞任务、完成任务、写结果评论和因证据变更而阻塞都会通知看板；只有运行就绪时才使用 `wakeAssignee=true`。 | 使用真实 `createBoardEvents.follow` 和内存实时适配器订阅，收到阻塞任务创建及无下游任务完成／评论的通知；阻塞创建不生成运行，完成不增加运行。 |
| R2 | 分开启动资料与完成资料。复盘启动不依赖自己应生成的 settlement，允许暂估原始计量／账单进入调查；无未解决事项的完成仍要求完整、确认的证据及已核对试算。含未解决项的有据结果停留在 review，不触发重复唤醒。资料更正使旧派生结果失效，再进入原队列。 | 从正常派单及唤醒产生的 Run 身份调用试算，没有先由人类 settle 解锁。核对 23700 元、调查 100 元账单差异、修正账单后完成、计量 80→82 后重新入队核对 24320 元；暂估可调查但不能经 complete 或 Ticket 更新假报完成；重复导入／核对不增加运行。 |

`businessWorkRequirements` 原字段和共享导出保留；新增 `businessWorkStartEvidence`、`businessSubmissionStream`、`resumeBusinessBotWork`。现有 RPC 名称及请求结构不变。`reconcileBusinessWork` 只增加一个可选参数，原两参数调用仍可用。没有新增数据库表、迁移或调度器。

## 本轮改动文件

- `packages/contracts/src/business-cycle.ts`：可空负责人及可选启动缺口。
- `packages/core/src/trading/business-cycle.ts`、`business-cycle.test.ts`：启动要求、阶段流及旧数据投影测试。
- `packages/db/src/business-cycle-evidence.ts`：阶段封存、回执追加及幂等。
- `packages/db/src/business-cycle-work.ts`：就绪／完成、状态通知、恢复权限及领取；`business-cycle.ts`：显式变更通知、调查与完成检查；`index.ts`：导出恢复函数。
- `packages/adapters/src/ticket-wake.ts`、`ticket-tools.ts`：有效负责人确认、原子领取和协调后唤醒。
- `apps/api/src/routes/bots.ts`：交易 Bot 恢复接回原任务链；通用 Bot 恢复不增加周期查询。
- `apps/api/src/business-cycle-fixes.postgres.test.ts`：新增七个真实数据库场景；`business-cycle.postgres.test.ts`：将更正后的期望从等待人类试算改为已可运行、尚不可完成。
- 本文：本轮唯一文档写入。未修改 Web、移动端、全局验收／进度文档或开发数据库。

## 本轮验证结果

所有通过数量均来自本轮命令，最终退出码为 0：

| 命令 | 结果 |
| --- | --- |
| `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=business-cycle` | 2 文件、12 项通过，含新增 7 项及原有 5 项；最终再次运行仍通过 |
| 同一命令，`--spec=trading` | 6 文件、87 项通过，原分析、批准、授权、执行、学习及天气回归 |
| 同一命令，`--spec=workspace-isolation` | 5 项通过 |
| 同一命令，`--spec=business-supervisor` | 2 项通过 |
| 同一命令，`--spec=row-security.postgres` | 17 项通过；上述数据库合计 123 项 |
| `pnpm exec vitest run packages/core/src/trading packages/adapters/src/ticket-tools.test.ts packages/adapters/src/ticket-changes.test.ts packages/adapters/src/job-reconciler.test.ts apps/api/src/board.test.ts` | 8 文件、111 项通过 |
| `pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api check` | 五包类型检查通过；API 在最后测试编辑后再次检查通过 |
| 对本文列出的 12 个源码／测试文件运行 Biome；`git diff --check` | 通过，没有全仓格式化 |

早期两次临时 PostgreSQL 启动健康检查超时，使用现有 testkit 的重试后成功；另修正了测试夹具类型错误及旧测试中“更正后必须 blocked”的过时期望。没有将超时、早期红测或历史通过数计入最终通过数，也没有修改系统时钟或测试超时规则。

## 限制

本轮验证后端事件发布与真实数据库／队列状态，不运行前端浏览器 E2E；前端草稿隔离、可空负责人显示以及 `startBlockers` 的界面适配和浏览器结果由前端会话负责。没有全仓 CI、原生设备、真实模型任务拆解／协作质量或真实接口验证。试算由确定性测试以实际排队 Run 的复盘身份调用，不声称模型已经自主完成业务。

开发业务库未读写或迁移。旧历史原文不改写；阶段分类发生在读取时。已有受损数据若缺少可识别阶段、负责人身份或存在无法判定的任务执行事实，本轮不猜测修改历史。主管及风控／复盘交易权限、算法启用与交易授权的分离仍由原服务检查，未扩大到实盘、RL 或其他产品。

## 后续 O1 运行诊断

浏览器验收中出现复盘 `review → doing`。只读追踪原业务的 Task/Run、工具效果、事件及日志后，确认是已经启动的复盘 Bot 显式调用 `ticket_update(status="doing")`，不是结算重核自动修改状态。人工调查仍保留；旧证据的 complete 请求被后端拒绝。之后第二次运行将任务显式设为 blocked 并等待输入，未删除原任务、Bot 或历史。

此行为符合当前“review 可继续调查，完成仍校验未解决事项与证据”的状态语义，本轮没有修改应用逻辑、RPC 或运行中业务。新增一个隔离 PostgreSQL 回归，覆盖人工完成、计量更正、人工调查、重核后仍 review、已分配 Bot 显式转 doing、调查保留、旧结果拒绝及无额外派单。业务周期两文件共 13 项通过，API 类型检查、定向 Biome 和 diff 空白检查通过；此前其他套件数量不计作本次重跑。

完整具体 ID、UTC 时间线和只读采集文件保存在本机被 Git 忽略的 `test-report/manual-business-cycle/20261105-browser-acceptance-a1abf0/o1-backend-investigation.md` 及相邻 diagnostics 目录。工具输出呈现／裁剪是否导致后续 blocked 仍是独立待查事项；数据库中的更正证据完整，未将模型自述作为效果验收或既定缺陷。

## 后续 O2 工具输出交付修复

已从同一 Run 的持久化结果与 runtime checkpoint 确认：默认 retrieval 策略将完整结果结构化缩短为仍含更正 ID 的有效 JSON，外层工具执行器却再次硬截到 12,000 字符，破坏 JSON 并丢失尾部证据。真实 `use_tool → business_cycle` 离线重放与原检查点文本逐字相同。Bot 后续重复读取及辅助查询均无法绕过这条交付路径，最后主动阻塞并等待输入。

`pi-runtime-tools.ts` 现在对已序列化的普通结果跳过重复硬截，保留结构化文本缩短、总上下文预算与原生工具内容上限；没有增加无限输出白名单或调整业务契约。`pi-runtime-serialize.test.ts` 新增 5 项完整交付／预算回归，先确认默认及 retrieval 两项红测，再通过修复；P25 更正资料的 82 MWh、24320 元、净利润 null 及引用链可在离线最终工具消息中读取。

本次运行时／上下文相关 30 文件 742 项通过，隔离业务周期 13 项通过，adapters/API 类型检查、定向 Biome 和 diff 空白检查通过。原业务只读比对中，2 个任务与工作结果、16 条证据、3 个既有 Run 的状态和更新时间不变，RAK-2 仍 blocked。没有重跑真实模型或浏览器，也未修改旧 Run 检查点；后续新读取才使用修复。旧 current 策略的原有截断行为保持，极大周期的分页和上下文容量另待验证。

具体运行 ID、时间线、前后交付差异与只读材料位于本机忽略目录 `test-report/manual-business-cycle/20261105-browser-acceptance-a1abf0/o2-backend-investigation.md`。未修改前端或总验收记录，未提交、推送或迁移。

## O2 真实模型续跑验收

按后续授权，已确认开发服务从当前 O2 修复源码重启，通过正常聊天提问卡的 `threads.answer` 恢复原复盘 Bot。使用真实模型及现有 Task/Run 队列，临时启用已有会话录制以核对实际工具消息；结束后恢复录制变量原设置，API/Web 保持可用。没有直接写库或人工设置业务任务状态。

首次新读取实际交付 19,855 字符、16 条证据的有效 JSON，最新计量、账单和结算对象与持久化结果逐字段相同；Bot 独立计算确认 82 MWh、24,320 元及账单差额 0，保留净利润 null。结构化长文本缩短仍有 `contextTruncated` 标识，但二次硬截断未复现。原 16 条证据逐字段保持不变，正常工具追加两版复盘；最终结果引用最新资料，任务停在 review，仍有未解决事项，不能声明业务全部完成。

续跑暴露独立问题：complete 接受本任务前版 review 为当前引用，追加新版本后该引用立即过期，协调器清空结果并重派。自动补跑先遭旧引用拒绝，随后 Bot 自行移除旧 review 的当前引用，保留历史链，提交的 rev4 稳定保存。此问题登记为 O3 待修，本次没有用人工改状态或删除历史规避。模型还将出清量与计量量不同、逐单批准下 grant 为空等推断为问题，这些并非本实现自动认定的违规，未按其建议更改出清或权限。

本次采集脚本的只读断言、真实工具响应及运行状态核验通过；未重跑此前单元／数据库／类型检查，未运行浏览器点击或原生设备验收。真实模型仅验证这一次续跑，不代表专业判断、协作质量或实盘通过。具体 ID、完整时间线、工具文本和保留验证见本机忽略目录 `test-report/manual-business-cycle/20261105-browser-acceptance-a1abf0/o2-live-acceptance.md`。本次只追加本文与本地验收材料，未提交或推送。

## O3：自身旧复盘引用导致结果立即失效（已修复，标准 RPC 定向复测通过）

### 复现与修复

O2 实际续跑已经留下完整的请求、结果和 Task/Run 时间线，本轮直接将该模式缩减为隔离 PostgreSQL 回归：首次提交带未解决事项的调查，再提交包含本任务上一版 review ID 的新调查。修复前 `complete` 返回 `status=todo,result=null`，不是预期的 `review` 与新结果。命令 `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=business-cycle-fixes` 确认新增一项失败、原八项通过（退出码 1），失败与原现场一致。

根因是把本任务的历史引用当成新结果的有效性依赖：新 review 替代上一版后，上一版从当前头集合中消失，新 review 随即被视为过期；协调器清空工作结果并再次派单。

修复仅调整 `packages/db/src/business-cycle.ts::complete`：在已鉴权、已锁定的当前周期内识别 `kind=review` 且 `streamKey=review:<本 ticketId>` 的历史记录。保留调用者完整的 `result.evidenceIds`，但将这些自身历史引用从新证据的有效性依赖 `references` 中排除。校验必需资料、校验当前版本及生成有效性依赖均使用其余业务输入。旧 review 的原文、来源和版本链保持不变，`supersedesId` 继续指向上一版。

### 接口与兼容语义

没有新增或删除 RPC、字段、错误码、共享导出、数据库列或迁移，也没有更改 `null` 语义。

- `BusinessWorkResult.evidenceIds` 仍为字符串数组，保留提交的原始顺序及内容；其中**本任务、本周期已存在的旧 review** 是历史引用，可以已被替代或因旧计量而失效。它不作为当前业务事实，不替代任何必需证据。
- 新 review 的 `BusinessEvidence.references` 只记录影响其当前有效性的依赖：当前业务输入及前序任务结果，不含本任务旧 review。`data.evidenceIds` 与工作结果仍保留历史引用，`supersedesId` 保留修订关系。
- 其他任务的 review 仍须是当前有效版本；旧计量、旧结算、未知 ID、跨周期／跨业务 ID 仍被拒绝，RPC 继续返回 `BAD_REQUEST` + `data.reason=STALE_DATA`。只有自身历史引用而没有必需业务输入时仍返回 `MISSING_EVIDENCE`。
- 相同内容重提（包括上一版已被当前提交替代后的重试、并发 RPC 重试）仍复用同一结果版本，不增建 Task/Run。带 `unresolved` 的结果保持 review；无未解决事项且完成条件满足时才为 done。
- 真正的计量更正或其他前序任务结果更新仍使依赖旧版的结果失效，经过原协调器及队列重办。没有放宽 `currentBusinessEvidence` 的全局判断，也没有抑制正常唤醒。
- Web、Electron、移动端使用同一服务，无需修改请求。前端若自行检查“所有 evidenceIds 都必须在当前头集合”应区分自身历史引用；当前页面只填必需业务证据，不受此兼容扩展影响。原有空结果／启动和完成缺口处理照旧。

已留下的 O3 旧复盘不自动改写、恢复或删除。本轮不修补开发数据，也不替 Bot 解决未决事项；后续正常提交可形成新版本。

### 实际改动与本轮测试

本轮只修改以下文件，保留此前有效改动及其他会话文件：

- `packages/db/src/business-cycle.ts`：上述历史引用与当前依赖的区分。
- `apps/api/src/business-cycle-fixes.postgres.test.ts`：新增三个 O3 集成场景，覆盖自身上一版与更早历史、review/done、重复／并发 RPC、历史保留、Task/Run 数量；P25 正常派单和工具服务身份下的 23700→24320、82 MWh、重复更正、过期／跨业务／未知引用和负责人权限；其他任务 review 的依赖失效与一次重派。
- 本文：本轮唯一正式文档修改。未修改前端或总验收文档。

| 本轮命令 | 实际结果 |
| --- | --- |
| `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=business-cycle` | 两文件 16 项通过，包含新增 3 项；使用临时 PostgreSQL 容器及按文件隔离数据库，未使用开发库 |
| `pnpm exec vitest run packages/core/src/trading/business-cycle.test.ts packages/adapters/src/ticket-tools.test.ts packages/adapters/src/ticket-changes.test.ts packages/adapters/src/job-reconciler.test.ts packages/adapters/src/pi-runtime-serialize.test.ts` | 五文件 73 项通过，覆盖共享证据、任务通知／恢复及 O2 序列化回归 |
| `pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api check` | 五包类型检查通过 |
| 两个改动源码／测试文件的 `pnpm exec biome check`、`git diff --check` | 通过，无全仓自动格式化 |

以上最终命令退出码均为 0。此前单项修复后的九项通过只作中间验证，不重复累计。过程日志在被 Git 忽略的 `test-report/o3-backend/`（`red.log`、`green-first.log`、`integration.log`、`unit.log`、`types.log`）。没有将隔离回归声称为模型效果或浏览器验收。

### 给 Desktop 的定向复测

本轮检查时原 API 3100、Web 5173、沙箱监督服务 7091 未监听，API/Web 健康请求为 connection refused；原临时进程日志也已不存在。因此**没有宣称应用服务已加载 O3**。复测前先按现有项目启动方式启动当前 checkout，核对所用分支和本节代码，避免连接旧服务或重建原业务库。

1. 打开原测试业务与 RAK-2，保存任务状态、当前结果、完整历史版本和原 Task/Run 数量。保留原 review／未解决事项，不强制转 done，不清除原等待运行。
2. 通过原 Bot 正常会话要求再次核对当前 82 MWh、24320 元资料，并在新结果 `evidenceIds` 中显式引用本任务上一版 review 作为历史说明；必须同时引用最新必需业务证据。也可用该已登录会话的标准 `businessCycle.complete` RPC 构造同一请求，注明这只能验收服务路径、不代表模型自主行为。若本次没有实际带上自身旧 review ID，不能算触发 O3。
3. 记录实际请求和响应。含未决事项时应为 review、result 非空；新 review 的 `data.evidenceIds` 保留该历史 ID，`references` 不含它，`supersedesId` 指向上一版。未决事项仍显示；重新读取／轮询不能自行变成 todo 或清空结果。
4. 用**完全相同的请求内容**重试一次：应保持同一个新 review ID，不增版本，不因提交结果额外创建 Task/Run。若使用正常聊天，区分用户主动开启的 Run 和完成结果意外触发的补跑，不要求聊天本身零运行。
5. 校验旧证据逐字段不变，结算仍为 24320、差额 0、净利润 null；检查没有出现新的自动重复运行。真实计量更正与其他前序结果替换的重办已经由隔离测试覆盖；如要浏览器补验，使用独立模拟业务，避免为复测改写原调查现场。
6. 若模型仍提出出清量必须同步成计量量或逐单批准必须有 grant 等判断，保留原话并独立核对，不能把它当作已验证业务缺陷或因此改证据／权限。

上述代码修复阶段没有运行 Desktop/Web 浏览器、原生设备、真实模型或真实交易接口复测，也没有启动／恢复原模型会话。后续实际环境验收结果如下。**看板断连恢复、同业务多周期仍是独立未完成验收项**，不因 O3 或 F2/F3 通过而关闭。

### O3 后续实际环境验收

Desktop 启动当前 checkout 后，通过正常本地登录账户的标准 RPC 提交含自身上一版复盘及最新必需业务证据的结果。首次产生 v5；完全相同的应用层请求重试复用同一 v5，没有新增版本。历史 ID 保留在结果和 `data.evidenceIds` 中、从当前 `references` 排除，`supersedesId` 保留版本链。原 18 条证据逐字段不变，四项未解决事项、分歧和提案保留，任务为 review。观察窗口内原业务没有新增 Task/Run。

两份保存的应用层 JSON 字节一致，但未捕获底层 HTTP 报文。O3 本次为人工 RPC，不是 Bot 自主复盘；另一个模拟业务产生的真实模型运行不计入本场景。请求、响应、只读快照与截图保存在本机忽略的验收目录；公开摘要见[收尾验收](eTraderBot-v1-acceptance.md#业务周期修复与定向复测收尾2026-11-05)。据此关闭 O3 规定服务行为的缺陷，未扩大验收范围。
