# eTraderBot v1 当前阶段验收

更新至 2026-11-07，最新阶段为[基座加固 01–09 验收汇总](eTraderBot-foundation-acceptance.md)。九张任务票按原范围及分层证据全部完成；真实模型连续演练已通过，业务数据仍为合成资料。公司交易接口、真实策略效果、论文算法及完整 CI 等不包含在该完成结论内。

## 基座加固阶段收尾（2026-11-07）

01–08 的独立验收及 09 的真实模型演练、D1/D2 补验共同支持本阶段结论。正常页面、代理辅助请求、构造记录、数据库/RPC、确定性执行器和真实模型的证据分别记录，不合并为一轮全量测试。

| 本阶段结论 | 证据边界 |
| --- | --- |
| 主管派单、专业产出、等待继续、负责人接续、Skill 复用和只读查询可在真实模型流程中运行 | 使用合成业务资料；人工批准、选择和编辑单独标记，不作为模型自主产出。 |
| 实际进程中断后自然恢复，旧 attempt 收敛且历史保留 | 真实模型补验命中只读调用之后；精确业务提交边界由独立确定性进程用例验证。 |
| 精确请求的副作用去重通过 | 以请求键、效果键、证据及评论完整记录/ID 核对；最终定向进程用例为 1 项通过、3 项未选择，不泛化为模型换键后的语义去重。 |
| 权限路径按原票分层满足 | 实际跨业务 RPC 404、撤权后工具不可见、隔离执行器的各类 refused 分开说明；后续补验新增真实模型缓存工具在撤销 Bot 分配后实际 refused，时序由测试控制。 |
| 中英文实测 390px 的相关页面完成验收 | 不等于 Electron 原生壳、原生移动设备或实际屏幕阅读器验收。 |

完整逐票入口和检查限制见[阶段汇总](eTraderBot-foundation-acceptance.md)。最初文档整理未重跑测试；后续[专项补验](eTraderBot-foundation-baseline-followup.md)已修复 testkit 类型及两组历史基线失败，并执行真实模型缓存工具撤权验证。仍未取得全仓 CI 通过结论。

以下保留历史批次的验收矩阵与当时限制。后续批次已补验的能力以日期较新的对应记录为准，不回改原测试计数或原失败结论。

## V01–V14 追溯

| 项目 | 当前结果 | 证据与边界 |
| --- | --- | --- |
| V01 三类完整流程 | 模拟结构流程通过 | 售电、发电、储能各自基线、两项批准、范围授权、部分成交／核对；三类学习候选人工启用后须再批交易，确认回执进入下一轮学习。真实模型解释与复盘语义未评价。 |
| V02 来源与数值 | 内部模拟通过 | 合成来源、缺字段／过期拒绝、固定点数值；无公司接口不伪造公司来源。真实字段映射、无外部服务及连通故障待联调。 |
| V03 版本和重放 | 当前基线通过 | 固定输入重放、参数版本和不可变证据；其他代码／模型产物及论文复现未实施。 |
| V04 逐笔批准 | 通过 | 算法与具体意图分别批准，身份／内容绑定、相同请求重试和换键拒绝。 |
| V05 范围授权 | 内部模拟通过 | 范围／Bot／版本／期限／单笔／累计检查；已用加占用不超限、并发与舍入核销。 |
| V06 撤销与不确定 | 内部模拟通过 | 授权撤销／过期后旧订单仍可核对；提交超时、撤单超时、持续不可用不释放额度；取消授权独立、回执追加、终态竞态。真实网络超时／崩溃恢复未验证。 |
| V07 算法与交易分权 | 通过 | 算法启用不生成交易权限，Bot 不能自批，学习运行不能执行／核对／撤单。 |
| V08 学习触发 | 结构行为通过 | 每日默认／时区／工具改计划、手动启动、并发合并、遗漏窗口恢复。真实模型对自然语言日程的理解未评价。 |
| V09 四类入口 | 当前授权资料流程通过 | 聊天、文件、操作、历史可追溯；追加回执进入新资料，旧会话输入固定。原生录制及复杂文档解析未验收。 |
| V10 学习与版本演进 | 部分通过 | 三类参数候选、训练／留出、约束失败／不足处理、人工启用及再审批通过；实际改进效果未建立，论文算法搁置。 |
| V11 隔离与共享 | 隔离及固定版本交接 MVP 已交付，验收有边界 | 交易／通用隔离、只读授权与撤销保持；同用户跨业务交接后端与 Web 已完成。权限与幂等通过隔离 RPC/PostgreSQL，浏览器正常流程与修复回归通过；浏览器 HTTP 重试、跨使用者共享及原生端未验收。 |
| V12 评价可靠性 | 部分通过 | 数据切分和约束证据完整，语义未评价／收益未建立明确保留；真实模型 rubric 校准及真实效果未执行。 |
| V13 模拟与真实隔离 | 当前边界通过 | 仅 simulation，synthetic 来源保留；不存在已接通公司交易或真实成交的结论。 |
| V14 角色与平台 | 部分通过 | 四模板、阶段与工具授权；Web 中英文及窄屏、共享桌面界面、移动组件与类型检查通过。未运行 Electron E2E 或原生设备验收。 |

## 可复核验证

- `pnpm test:integration --spec=trading`：5 个文件、81 项通过（实际 PostgreSQL 事务和 RPC／Bot 工具）。
- `pnpm test:integration --spec=row-security.postgres`：17 项通过；新回执和模拟配置表另在交易测试验证跨身份拒绝。
- `pnpm exec vitest run packages/core/src/trading packages/contracts/src/trading-workspace.test.ts apps/mobile/lib/trading-screen.test.tsx`：4 个文件、51 项通过。
- `LOCAL_AUTO_LOGIN_EMAIL= pnpm test:e2e '--spec=(trading|trading-templates|ui-locale)\.spec\.ts'`：5 项 Chromium 通过，覆盖两项审批、限额授权、部分成交、撤单超时、核对核销、学习入口、四模板与语言切换；已查看合成数据截图。
- contracts、core、db、api、web 类型检查及 `EXPO_OFFLINE=1 pnpm --filter @rakazo/mobile check` 通过；移动依赖校验使用缓存，不代表联网依赖核验。
- `pnpm --filter @rakazo/web build` 通过，仍有已有大 chunk 提示。Biome 与 diff 空白检查通过。

迁移在临时测试数据库验证后，备份本地分支数据库再应用；16 张既有交易表的原字段指纹一致。原始迁移未改写，新增迁移保留旧字段默认行为和证据。本地页面与交易查询返回正常，新场景／占用／回执历史字段可读，浏览器未见脚本错误；未提交或推送。本批未运行全仓 CI、真实模型费用／效果、真实公司接口、Electron 或原生设备检查。

主要测试文件：

- [审批与执行](../../apps/api/src/trading-control.postgres.test.ts)
- [Bot 工具权限](../../apps/api/src/trading-bots.postgres.test.ts)
- [学习闭环](../../apps/api/src/trading-learning.postgres.test.ts)
- [定点核销](../../packages/core/src/trading/execution.test.ts)
- [浏览器交易流程](../../apps/web/e2e/trading.spec.ts)
- [移动界面操作](../../apps/mobile/lib/trading-screen.test.tsx)


## V1.1 第一批增量验收（2026-11-04）

本节为当前最新隔离验收，上述 V1 命令与计数保留为历史记录。天气接入改动一并保留。详细行为及离线迁移步骤见[工作区隔离说明](eTraderBot-v1.1-workspace-isolation.md)。

| 验收点 | 结果与证据 |
| --- | --- |
| 类型与角色 | 后端创建、复制、导入和数据库触发器限制工作区类型；角色不可原地提升。浏览器只呈现当前类型的模板。 |
| 普通 Bot 写入隔离 | 每次运行/工具复核身份、Space 与电脑；真实 PostgreSQL 测试覆盖交易工具、文件、共享记忆、MCP、Skill/HTTP 安装 RLS、跨 Bot 通信及凭据库边界。宿主电脑与 stdio MCP 对普通 Bot 关闭。 |
| 最小只读授权 | 默认拒绝，精确接收 Bot/源区/资料；错业务、错 Bot、撤销、源成员资格丢失均拒绝。撤销与读取通过行锁协调，拒绝记录留存；复制不继承资料授权。已经交付的文字不能收回。 |
| 模拟流程回归 | 分析、双审批、范围授权、部分成交、超时核对、撤单、回执、学习和天气接入共 87 项 PostgreSQL 回归通过。 |
| 迁移证据 | 隔离副本先验证；备份后本地迁移普通 Bot 的 1 段聊天、7 条消息、33 条事件、1 份记忆、3 次运行。ID/关联与解密内容一致，20 张交易表共 23 条记录完整行指纹不变。共享记忆、原电脑保留在交易区。 |
| 多端与导航 | 共享 Web/Electron UI 和移动类型/模板入口已同步，全部 Bots 切换实际上下文；复杂配置在 Web 安全降级。原生设备和 Electron E2E 未运行。 |

可复核命令：

- `pnpm test:integration --spec=trading`：6 文件、87 项通过。
- `pnpm test:integration --spec=workspace-isolation`：1 文件、5 项通过，含原始 SQL、工具旁路、授权/撤销、加密迁移与歧义/陈旧指纹拒绝。
- `pnpm test:integration --spec=row-security.postgres`：17 项通过。
- `pnpm exec vitest run packages/adapters/src/executor packages/adapters/src/run-tools apps/web/src/pages/SpaceSettingOverrides.test.tsx apps/mobile/lib/space-settings.test.tsx`：27 文件、854 项通过。
- `pnpm exec vitest run apps/api/src/agent-import.test.ts packages/adapters/src/honcho-memory-provider.test.ts packages/adapters/src/mcp-connector.test.ts packages/db/src/cross-space-communication.test.ts apps/mobile/lib/space-settings.test.tsx`：5 文件、202 项通过（与上一组有组件重叠）。
- `LOCAL_AUTO_LOGIN_EMAIL='' pnpm test:e2e '--spec=(workspace-isolation|trading|trading-templates|trading-weather|ui-locale)\.spec\.ts'`：7 项 Chromium 通过；已查看中英及窄屏合成数据截图。
- `pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/web check`、`EXPO_OFFLINE=1 pnpm --filter @rakazo/mobile check`、`pnpm --filter @rakazo/web build` 通过。离线依赖检查不代表联网核验；构建仍有既有大 chunk 提示。

新增测试入口：[隔离与迁移集成](../../apps/api/src/workspace-isolation.postgres.test.ts)、[工作区浏览器流程](../../apps/web/e2e/workspace-isolation.spec.ts)。未运行全仓 CI、真实模型语义/成本/效果、公司内接口或原生设备测试；这些不是本批通过的结论。ADR 0005 经验交接仍待下一批，独立强化学习、论文算法和实盘继续暂缓。

本地开发服务已恢复；浏览器确认迁移后两类工作区及各自 Bot 可见，聊天切换使用对应工作区上下文，未观察到页面脚本异常。

## 业务主管增量验收（2026-11-04）

每条已配置的交易业务工作区新增一位固定主管。四类专业模板与普通通用 Bot 归属不变；主管以任务协作为职责，不能获得交易执行或批准资格。详细定义见[业务主管实施说明](eTraderBot-business-supervisor.md)。

| 验收点 | 结果与边界 |
| --- | --- |
| 自动建立且唯一 | 新业务事务内创建、旧业务按所有者读取补建；数据库唯一约束及并发测试通过。待迁移工作区不自动补建。 |
| 任务分配 | 现有看板与工具分派，真实 Task/Run 入队并通知工作队列；跨业务／非本人 Bot 拒绝。 |
| 信息汇总 | 查询任务评论、最近结果、阻塞和团队运行状态；真实模型自然语言总结质量未验证。 |
| 进度 | 全量状态聚合通过，不受最近 30 条展示限制；`done` 计完成，`closed` 不计，运行结束不自动完成任务。 |
| 权限与迁移 | 复制／归档／变更角色及交易操作拒绝；原 6 个 Bot、20 张交易表指纹保留，新增主管不搬运通用 Chief 或旧聊天。 |
| 多端 | Web/Electron 共用总览与派单界面，中英和窄屏浏览器通过；移动总览及原生看板入口类型检查通过，原生设备未运行。 |

最终定向验证：主管 PostgreSQL 2 项、交易回归 87 项、隔离回归 5 项、运行器／看板等单元 902 项通过；5 个不同 Chromium 场景分批通过。七包类型检查、mobile 离线检查和 Web 构建通过。具体命令及截图见[实施记录](eTraderBot-v1-progress.md)。这些结果不替代真实模型、真实公司接口、实盘、全仓 CI 或原生设备验收。

## 模拟业务周期验收（2026-11-05）

本节是本轮交付记录，前文结果保留为历史。本轮基于 `998c6bae` 的现有分支推进，没有提交或推送；课程审查稿及原有效改动保留。范围和完整演示见[业务周期说明](eTraderBot-business-cycle.md)。

| 验收点 | 实际结果 |
| --- | --- |
| P25 电能量结算 | 实际业务服务与页面均得到 23700 元；双偏差和等价差价一致，分项 30000／−3200／−3100。显示缺成本和费用、净利润未建立；规则及数据明确标为教学模拟。 |
| 合同与物理约束 | 金融合约 100 MWh 不扣成物理占用，90 MWh 可用电量可生成 90 MWh 候选；100 MWh 物理承诺超过 90 MWh 可用量时拒绝。时段、参考点和覆盖完整性由后端校验。 |
| 规则与批准 | 日内／实时结果阶段不接受重新申报，关闸后拒绝，新准备不能绕过已封存申报。Bot 候选要求该场景匹配版本已经启用，改参数不能复用原批准；算法启用与交易批准独立。 |
| 权限及旁路 | 周期 RPC 拒绝跨业务；真实 `business_cycle` 工具拒绝普通 Bot 读取和主管／风控候选写入；风控／复盘／主管不能经原交易工具准备或执行，不能用普通 Ticket RPC/工具将缺证据任务强行完成。 |
| 证据与幂等 | 合同、真实持久化的模拟申报、出清、履约、计量、账单和试算引用可追踪。相同内容／记录重复导入或重复核对不重复计账，并发同请求去重；源内容冲突及跨周期引用被拒绝。 |
| 暂估及更正 | 启动调查与完成条件分开；计量暂估时不得完成复盘，有未解决事项的调查保留为 review。更正 80 → 82 MWh 保留原版本及 23700 元旧试算，旧结果失效，新核对为 24320 元，复盘须重新办理。 |
| 按需和并行 | 合同查询只创建 1 个中长期任务／Run。独立合同、现货和风控任务各自入队；依赖合同结果的现货任务等待，前序完成后才增加其 Run。缺计量／账单／结算时不得完成复盘。 |
| 主管与专业结果 | 主管读取来源、依赖、阻塞、分歧及未解决项，不能冒名提交专业完成结果或代人工批准。人工演示结果明确标注来源，不作为真实 Bot 结果；改进提案不自动启用算法。 |
| 兼容及迁移 | 副本预验后备份并迁移本地分支库，28 张旧表完整行指纹一致。新增四表及 RLS，不搬运旧业务、Bot、聊天、记忆和交易证据。未配置周期的旧流程保持原行为。 |
| 多端 | Web/Electron 共用新增操作页；移动提供只读周期及历史，写入降级到 Web。全部 Bots 导航与直接专业会话保留，业务默认入口为主管。原生设备／Electron 原生壳未实测。 |

本轮通过的定向命令（均正常退出）：

- `pnpm test:integration --spec=business-cycle`：1 文件、5 项综合场景，真实 PostgreSQL、认证 RPC、Bot 工具及原 Task/Run 入队；包含算法未批准／变更参数的拒绝。
- `pnpm test:integration --spec=trading`：6 文件、87 项，覆盖原分析、双审批、授权、执行生命周期、回执、学习和天气接入。
- `pnpm test:integration --spec=workspace-isolation`：5 项；`pnpm test:integration --spec=business-supervisor`：2 项。
- `pnpm test:integration --spec=row-security.postgres`：17 项。上述数据库测试合计 116 项。
- `pnpm exec vitest run packages/adapters/src/executor packages/adapters/src/run-tools packages/adapters/src/ticket packages/core/src/trading apps/api/src/board.test.ts apps/web/src/pages/Board.test.tsx apps/web/src/lib/query.test.ts`：35 文件、959 项。
- contracts/core/db/adapters/API/worker/Web 类型检查分批通过；`EXPO_OFFLINE=1 pnpm --filter @rakazo/mobile check` 通过，离线依赖提示仍存在，不代表联网依赖核验。
- `pnpm --filter @rakazo/web build` 通过，保留已有大 chunk 提示。改动源码 Biome、diff 空白检查及 Gitleaks 脱敏扫描通过。

浏览器最终共 6 个不同 Chromium 场景分批通过：`NODE_ENV=test pnpm test:e2e --spec=<场景>`，场景为 `business-cycle`、`business-supervisor`、`trading.spec`、`trading-templates`、`workspace-isolation`、`trading-weather`。P25 场景通过真实页面操作完成双审批、申报、出清／履约、计量、23700 元核对、人工有据复盘及 82 MWh 更正后 24320 元重算，并覆盖中英、390px、风险 Bot 无交易按钮。合成截图已查看并保存在[英文](../demo/business-cycle-p25-en.png)、[中文窄屏](../demo/business-cycle-p25-narrow-zh.png)。

早期并行浏览器尝试不计通过：出现创建业务的序列化冲突、导航控件角色不匹配，以及系统时钟跳变后的录屏编码／上下文清理超时。导航已改为原生链接并重新通过 P25 场景。其余五个回归单独运行时临时关闭本地录屏，保留断言、截图及 trace；完成后逐字恢复原 Playwright 配置，没有放宽超时、修改业务规则或跳过断言。最终结果不代表并发负载验收。

本地只读烟测：Web/API 可用，周期页面和当前业务 `businessCycle.list` 成功，页面脚本异常为零；没有往原业务写入演示交易。旧库备份及迁移副本保留，运行身份授权已由既有迁移命令更新。本地 worker 未为本次验收启动。

本轮没有验证真实模型的拆解、协作及总结质量；离线入队、结构校验和人工结果不能替代该效果验收。真实交易接口、正式计量／账单、三省完整规则、辅助服务、跨业务资产承诺汇总、完整成本利润模型、储能周期轨迹、固定版本经验交接、论文复现、独立训练和算法插件市场仍待后续。全仓 CI、Electron E2E、iOS/Android 原生设备未运行。

## 业务周期修复与定向复测收尾（2026-11-05）

本节更新上述初次实施后的验收状态，不将各阶段通过数累加为一次全仓测试。修复范围分别见[后端记录](eTraderBot-business-cycle-backend-fixes.md)和[前端记录](eTraderBot-business-cycle-frontend-fixes.md)。原始请求、快照、模型工具消息及人工浏览器截图保存在本机忽略的验收目录，不随源码发布。

| 项目 | 收尾结果与边界 |
| --- | --- |
| 后端五项修复 | 阶段申报封存、有效负责人原子领取、空负责人恢复、看板通知与执行唤醒分离、调查启动与完成条件分离均已实现并通过定向回归。 |
| F1 草稿与错误提示 | 草稿按周期和任务隔离；失败原因在任务表单内显示，字段超限有上限提示，失败和提交期间的新输入保留。单元、隔离浏览器及实际页面复测通过。 |
| F2 归档负责人刷新 | 周期页与侧栏共享名单；实际页面从侧栏归档负责人后无需重载即显示已归档，同专业替换后结果和历史保留。 |
| F3 中文业务拒绝 | 按既有拒绝代码映射本地化提示；暂估计量下尝试完成复盘，实际页面显示中文缺证据提示，草稿保留。其他拒绝代码的翻译由单元测试覆盖。 |
| O1 任务状态变化 | 实际运行追踪确认 review → doing 来自已启动 Bot 显式恢复调查，人工结果和未解决事项未被覆盖，按正常行为关闭。 |
| O2 工具 JSON 交付 | 去除结构化序列化后的重复硬截断；离线回归与一次真实 Bot 续跑通过，正确读取 82 MWh、24320 元和最新引用。长叙述仍受上下文预算约束，不代表全部专业判断或协作质量通过。 |
| O3 自身旧复盘引用 | 自身历史引用保留在结果中，与当前有效性依赖分开。人工标准 RPC 复测实际包含上一版复盘和最新业务证据，重复同一应用层请求复用同一新版本；原 18 条证据逐字段保留，观察窗口内没有意外补跑。此项不是模型自主复盘。 |

最新分项执行记录：后端 PostgreSQL 16 项、相关单元 73 项和五包类型检查通过；前端 Web 单元 1730 项、类型检查及四项隔离浏览器回归通过。随后 O3 经标准 RPC、F2/F3 经实际页面操作定向通过。原业务任务保留四项未解决事项并停在 review，不能把缺陷验收通过写成业务强制完成。

本轮确认缺陷已关闭。看板断连恢复、同业务多周期、原生 Electron／移动端、全仓 CI、多 Bot 协作质量及真实交易接口仍未验收。独立模拟业务出现模型提供方拒绝后切换的记录，原因和是否符合配置尚未调查，仅列环境观察，不认定为代码缺陷。

## 固定版本经验交接 MVP 收尾（2026-11-05）

本节更新旧批次“交接待实施”的状态。功能、目录来源类型和前端 F1/F2/F3 修复一并
整理，依据[后端记录](eTraderBot-experience-handoff.md)、
[前端记录](eTraderBot-experience-handoff-frontend.md)及本机忽略目录中的实际浏览器报告。
沿用已有测试证据，本次不重跑整轮浏览器验收，不把分阶段计数累加为全仓结果。

| 验收点 | 结果与证据边界 |
| --- | --- |
| 固定包与独立副本 | 所选总结、原生记忆及文本 Skill 保存来源、版本、哈希及适用条件；预览只读，确认原子写入独立副本。Skill 默认待启用，冲突显式改名/跳过。隔离测试与实际页面流程通过。 |
| 目录与旧包 | 必填 `sourceType` 区分本 Bot/共享记忆及两类 Skill；只扩展目录，不改写 v1 旧包或哈希。旧包测试通过，来源标签经单元与浏览器修复回归验证。 |
| 源权限撤销 | 先预览再撤销源成员资格，读取/确认拒绝且无副本；恢复后原请求可重试。**通过的是隔离进程内 RPC/PostgreSQL 测试**，不是浏览器成员权限操作。 |
| 敏感能力隔离 | 用非空加密模拟凭据、连接、算法批准、交易批准和有效范围授权验证不转移；目标算法及交易权限仍独立拒绝。**通过的是隔离 RPC 测试**；实际页面空授权和角色不变只算有限补充。 |
| 相同请求幂等 | 完全相同 confirm JSON（含原 previewHash）串行 4 次＋重试、并发 4 次＋重试，分别仅 1 回执、2 记忆/首版修订、1 待启用 Skill、1 导入事件，0 Task/Run。**通过的是隔离 RPC 测试，浏览器 HTTP 重试仍未验证**。 |
| 历史与失败恢复 | 源更新不改变旧版本；包撤销阻止新导入，已导入副本保留，源 Bot 删除后历史可读。数据库失败回滚/重试经隔离测试；真实页面正常导入、撤销和历史经人工验收。 |
| 前端修复 | 同名记忆来源、STALE_PREVIEW 后保留方案并立即重新预览、错误随语言更新，已通过修复后的单元及隔离浏览器回归；未重新执行整轮人工浏览器验收。 |
| 模型使用 | 实际浏览器报告记录目标 Bot 两次真实运行成功读取导入 Skill；不证明模型自主生成手工总结、模型质量提升或交易收益。 |
| 数据与多端 | 新增四表，不搬运旧资料；开发分支库曾在获授权的人工验收中标准迁移，原调查证据/工作记录定向指纹一致。本次不改业务数据。Electron 共用 Web，原生壳未测；移动端暂无入口。 |

既有最终结果：交接隔离 PostgreSQL **24 项**通过；Web 单元 **184 文件 / 1741 项**
（交接页面 10 项）、交接浏览器 **1 项**通过；相关类型与定向 Biome 检查通过。
首批原隔离、业务周期、加密和运行时回归的命令及计数保留在后端记录，不冒充此次重跑。

剩余：浏览器 HTTP 层完全相同请求重放、并发和响应丢失后重试；Electron/原生移动端
与全仓 CI；外部记忆原子导入、跨用户共享、Skill 正文编辑界面和模型效果验证。
没有扩展实盘、论文复现或独立强化学习。服务启动与 Windows 可达性另行核对，
不以 WSL 内监听成功或历史临时转发地址作为当前 Windows 访问验证。

本次提交检查另通过：contracts/db/adapters/API/Web 五包类型检查、35 个相关 TypeScript
文件 Biome、暂存差异检查和 Gitleaks 脱敏扫描。未重复整轮浏览器或 PostgreSQL 验收。
