# 业务周期前端修复记录

本记录覆盖 Web／Electron 共用页面 `BusinessCycle.tsx` 的 R3 草稿隔离，以及与后端 5 项修复（见 [后端修复记录](eTraderBot-business-cycle-backend-fixes.md)）的界面联调。前端没有修改 `packages/contracts`、`core`、`db`、`adapters` 或 `apps/api`，没有改变接口及业务校验，没有读写开发业务库，未 reset、clean、提交或推送。

## 草稿隔离（R3）

原页面所有任务表单共用一组摘要／分歧／未解决／提案状态，并行编辑会互相覆盖，提交时可能把一个任务的正文与另一任务的证据组合，切换周期也会带入旧草稿。

| 方面 | 行为 |
| --- | --- |
| 隔离 | 草稿以 `周期 ID:ticketId` 为键保存在页面内存中，不写浏览器存储。不同任务、不同周期互不影响；同一页面内切回原周期草稿仍在。Shell 以 Bot ID 为键挂载页面，切换业务即重新挂载并丢弃草稿。 |
| 提交绑定 | 点击时确定 ticketId、正文快照及该任务所需流的当前证据 ID；之后的编辑或刷新不改变已发出的请求。 |
| 结果 | 成功只清空仍等于已发送内容的字段，请求期间新输入保留；失败不清空，沿用原错误提示。轮询及重查不覆盖未提交输入。 |

## F1：提交失败就近说明原因

来源：[浏览器验收 a1abf0](../../test-report/manual-business-cycle/20261105-browser-acceptance-a1abf0/report.md) F1。原页面提交失败只在页首显示通用“Could not continue”，任务表单附近没有字段和限制。

| 情形 | 行为 |
| --- | --- |
| 超出契约长度 | 提交前用共享 `BusinessWorkResultSchema` 校验同一份请求快照（与服务端同一来源，未改上限）。不合规时不发请求，在该任务表单按钮上方显示“{字段} must be {上限} characters or fewer”（中文“{字段}不能超过 {上限} 个字符”），对应输入框 `aria-invalid`，并以 `aria-describedby` 关联提示。 |
| 服务端校验拒绝 | 读取 `BAD_REQUEST` 的 `data.issues`，按 `result.<字段>` 路径映射到同一字段提示；有 `maximum` 时给出上限。 |
| 其他服务端拒绝或网络失败 | 在该任务表单显示 `errorText` 的具体原因（如后端业务提示、“Could not reach the server”），全部输入关联该提示；不再出现页首通用提示。 |
| 草稿 | 任何失败都不清空草稿；提示按 `周期:ticketId` 隔离，只出现在失败的任务。修改出错字段（通用失败时修改任一字段）后提示消失，再次提交时重新判断。 |

身份确认流程照旧由原对话框处理。前端交付时，验收会话的临时诊断仍预设超长请求会发到服务端，因此在前端提前拦截后失败。随后验收会话已保留原红测材料，更新该实现假定，继续验证就近提示与草稿保留，并补充独立的服务端拒绝场景：诊断 3 项及正式页面回归 14 项均通过。命令和日志见[验收报告](../../test-report/manual-business-cycle/20261105-browser-acceptance-a1abf0/report.md)。

## F2、F3：归档即时更新与中文业务拒绝

来源：[浏览器续测 b3e942](../../test-report/manual-business-cycle/20261105-browser-continuation-a1abf0-b3e942/report.md) F2、F3。

**F2 原因**：周期页自己查询 `bots.list`，只在负责人缺失或不在列表时轮询。负责人在列表中时被归档，页面不刷新，直到重新加载。侧栏的“已归档”来自 Shell 自己的名单状态，与周期页不是同一来源。

**F2 修复**：Shell 把同一份名单（`useSpaceRoster` 的 `bots`：归档操作后立即刷新，平时每 3 秒轮询，切回窗口时也刷新）作为 `roster` 传给周期页；周期页删除自己的 Bot 查询及按需轮询，负责人显示、归档判断、恢复候选和现货快捷入口都读这一份名单。同标签页归档立即反映，其他标签页或其他用户的归档在下一次名单轮询后反映。`Shell.tsx` 只增加 `roster={bots}` 一个属性。

**F3 原因**：服务端业务拒绝的 `message` 是后端英文文案，前端原样显示。

**F3 修复**：周期 RPC 已把 `TradingError` 的代码放在错误的 `data.reason`。任务提交失败时按代码显示界面语言文案：

| 代码 | 文案（英／中） |
| --- | --- |
| `MISSING_EVIDENCE` | Required evidence or a prerequisite result is still missing／所需证据或前序任务结果尚未齐全 |
| `STALE_DATA` | Evidence changed. Check the latest versions and submit again／证据已更新，请核对最新版本后重新提交 |
| `FORBIDDEN` | You can't record this result／你无法记录此结果 |
| `NOT_FOUND` | This task is no longer available／该任务已不可用 |

以上覆盖 `complete` 路径的全部业务拒绝代码。未知代码显示已翻译的通用“无法继续”，不再显示未翻译的服务端原文；无代码的失败（网络、其他层错误）仍走原 `errorText`。提示位置、字段关联与草稿保留同 F1。

**后端需求（可选，非本次阻塞）**：`FORBIDDEN`、`NOT_FOUND` 在 `complete` 路径各有多种含义（业务空间不可用、非指派专业 Bot、任务或周期不存在），前端只能给出概括文案。若需要更具体的提示，请为这些情形提供区分的 `data.reason`（例如 `WORKSPACE_UNAVAILABLE`、`ASSIGNEE_ONLY`、`TASK_NOT_FOUND`、`CYCLE_NOT_FOUND`），保留现有 HTTP 状态与 `message`。`MISSING_EVIDENCE` 也对应“缺少证据／前序结果”和“结果未引用全部所需版本”两种文案；后者在页面自动填写引用时不会出现，若要区分可另设代码。缺失项列表已由任务的“完成仍需”展示，不需要随错误返回。周期页其他操作（导入、核对、派单、恢复负责人等）的页首错误仍显示服务端原文，本次未改。

## 最终接口语义适配

| 后端语义 | 界面表现 |
| --- | --- |
| `startBlockers ?? blockers` 为启动缺口 | 有缺口时显示“Blocked／阻塞: …”，不显示结果表单。旧服务未返回 `startBlockers` 时退回 `blockers`。 |
| `task.blockers` 为完成缺口 | 可启动但仍有完成缺口时显示“Ready to investigate · Needed to complete: …”（可以开始调查 · 完成仍需），表单可用于记录调查结果。两类缺口都为空时显示原“Required evidence available”。 |
| 周期 `reviewReady`／顶层 `blockers` | 维持原“可进行复盘／等待证据”提示，不由任务启动状态推导。 |
| 带 `unresolved` 的调查结果保留为 `review` | 状态直接显示后端返回值；结果、未解决事项及完成缺口同时可见，表单保留以便后续补充。页面不自行把任务标为完成。 |
| 计量更正后可重启但待新试算 | 复盘任务显示 `todo`，并显示“完成仍需: evidence:settlement”；结算区隐藏旧试算直到重新核对。 |
| 申报证据按阶段分流 | 证据按 `kind="submission"` 识别，标题与历史显示 `data.stage`（如 `day_ahead`、`mid_long_term`）。共享读取投影使日前为 `submission`、其他阶段为 `submission:<stage>`，页面不把单个流当作全部阶段。 |

## 负责人缺失与恢复

- `assigneeBotId` 为 `null` 时标题显示“Unassigned／未分配”；负责人已归档（不在活跃 Bot 列表中）时显示“Archived／已归档”；否则显示负责人名称。
- 负责人缺失或已归档时，任务内出现最小恢复入口：“Assignee／负责人”下拉及“Restore／恢复”按钮，调用既有 `tickets.update({ id, assigneeBotId })`，经原身份确认流程，没有新增 RPC。候选只列出当前业务中与任务专业角色一致、未归档、非业务主管的 Bot；同所有者等其余条件以后端校验为准，拒绝时显示后端错误。
- 恢复后历史结果原样保留，标题中的状态与后端重新读取的任务状态一致（浏览器用例按后端返回值断言，不预设具体状态）。
- 负责人、候选及归档判断读取 Shell 名单（见 F2），其他入口删除、新建或归档 Bot 后无需重新加载。

既有看板工单编辑对话框对空负责人的处理（默认选中第一个 Bot 且不发送该选择、未按角色过滤）未修改，周期页入口不依赖它。

## 改动文件

- `apps/web/src/pages/BusinessCycle.tsx`：读取 Shell 名单（F2）、按拒绝代码显示界面语言文案（F3）、提交失败就近提示与契约长度校验（F1）、草稿隔离、提交快照、启动／完成缺口区分、负责人显示与恢复、Bot 列表按需刷新、申报阶段显示；任务容器 `data-testid="cycle-task-<ticketId>"`。
- `apps/web/src/pages/BusinessCycle.test.tsx`（新增）：jsdom 单元回归 15 项。
- `apps/web/src/pages/Shell.tsx`：向周期页传入 Shell 名单 `roster={bots}`（F2）。
- `apps/web/e2e/business-cycle-drafts.spec.ts`（新增）：浏览器回归 3 项（草稿隔离、看板事件、负责人恢复）。
- `apps/web/e2e/business-cycle.spec.ts`：计量更正后的期望由 `blocked` 改为“可启动、待新试算”，并增加带未解决事项的调查提交、确认保持 `review` 而非 `done`。
- `apps/web/src/locales/*/messages.po`：`intl:extract` 新增 `Assignee`、`Needed to complete`、`Ready to investigate`，并为复用的 `Archived`、`Restore`、`Unassigned` 补来源注释；按仓库惯例填写 `en`、`zh-CN`、`zh-TW`，其他语言留空回退英文。与提取前快照对比，每个语言仅这 15 行差异。F1 另新增 `{label} must be {limit} characters or fewer`（填写 `en`、`zh-CN`、`zh-TW`）并为复用的 `Could not continue` 补来源注释，每个语言再增 5 行。F3 新增 4 条拒绝文案（填写 `en`、`zh-CN`、`zh-TW`），每个语言再增 16 行，无其他差异。

## 验证结果（本轮实际运行）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @rakazo/web check` | 类型检查通过 |
| `pnpm --filter @rakazo/web test` | F2、F3 修复后 183 文件、1730 项通过（F1 后为 1729）。此前中途一次全量运行出现 1 项失败，随后连续三次全量均通过，未能定位该偶发项；`BusinessCycle.test.tsx` 每次均通过 |
| `biome check` 四个改动源码／测试文件 | 通过 |
| `API_PORT=3210 WEB_PORT=5280 LOCAL_AUTO_LOGIN_EMAIL='' NODE_ENV=test pnpm test:e2e '--spec=business-cycle\.spec'` | 1 项通过：双审批、申报、出清／履约、计量、23700 元，更正为 82 MWh 后复盘可启动但待试算、调查结果保持 review，更正后在中文界面不填未解决事项提交，真实服务以 `MISSING_EVIDENCE` 拒绝，表单内显示“所需证据或前序任务结果尚未齐全”且摘要保留，补填后提示消失，再核对得 24320 元，中文 390px 无横向溢出，风控 Bot 无交易按钮 |
| 同上，`--spec=business-cycle-drafts` | 3 项通过（F2、F3 修复后再次运行仍通过）：合同／风控同时编辑不串稿；拦截失败时原因只显示在风控表单内（“Could not reach the server”），合同表单与页首无提示，草稿保留；合同分歧填 2001 字符时不发请求，表单内显示“Disagreements must be 2000 characters or fewer”且字段标为无效，改回后提示消失；两次轮询保留；提交风控的 ticketId、正文和证据对应风控，合同草稿不变；切换业务表单为空且提交只带本业务证据，原业务任务不受影响；打开看板后在页面外完成无下游任务，卡片经事件移至 Done；删除专业 Bot 后显示未分配，候选只含同角色新 Bot，恢复后显示新负责人、历史结果保留且状态与后端一致；随后在页面外归档该负责人，已打开页面无需重新加载即显示“Archived”，新建同角色 Bot 后出现为唯一候选并可再次恢复，历史结果保留 |

单元测试覆盖：Shell 名单变化时（归档后）页面显示“Archived”并在出现同角色 Bot 后提供唯一候选，结果保留；按代码显示拒绝文案而非服务端原文，未知代码显示通用文案；超长字段提前拦截并就近提示（2000 字符可提交、2001 字符拦截）；服务端校验问题映射到字段；服务端业务拒绝显示在任务表单内且页首无提示；任务间／周期间隔离与切回恢复；失败及重查保留；请求中追加输入保留；启动与完成缺口区分及旧服务回退；带未解决事项的调查提交保持 review；空负责人与归档负责人；按角色恢复且结果保留；缺失负责人时 Bot 列表刷新；两个申报阶段分别显示。

截图（合成数据，已查看）：

- `apps/web/test-results/business-cycle-p25/business-cycle-p25-en.png`：23700 元及复盘完成。
- `apps/web/test-results/business-cycle-p25/business-cycle-p25-narrow-zh.png`：中文 390px，更正后 24320 元。
- `apps/web/test-results/business-cycle-drafts-para-*/business-cycle-drafts-en.png`、`business-cycle-drafts-narrow-zh.png`：并行草稿与另一业务的中文窄屏。
- `apps/web/test-results/business-cycle-drafts-para-*/business-cycle-field-limit-en.png`：超长分歧的就近提示与另一任务的网络失败提示（F1）。
- `apps/web/test-results/business-cycle-p25/business-cycle-refusal-zh.png`：中文界面的真实业务拒绝就近提示（F3）。
- `apps/web/test-results/business-cycle-drafts-a-ta-*/business-cycle-owner-archived-en.png`：页面打开期间归档负责人后的状态与恢复入口（F2）。
- `apps/web/test-results/business-cycle-drafts-a-ta-*/business-cycle-owner-missing-en.png`：负责人缺失、启动缺口 `assignee:missing` 与恢复入口。

Playwright 每次运行会清空 `test-results/`，P25 截图在补跑草稿用例前另存后放回 `business-cycle-p25/`。

## 原 P25 失败原因

此前两次 P25 失败（一次身份确认框重新出现，一次关闭浏览器上下文超时）并非并发编辑所致，之前的“并发干扰”解释不成立。实际原因是 WSL 系统时钟约每 5 秒在两个值之间跳变约 16 小时：`systemd-timesyncd` 按 NTP 校正，Windows 主机同步又把时钟改回。身份确认按时间判断新鲜度，跳变后被视为过期；Playwright 录像以墙钟时间标记帧，录制首尾跨越跳变时需补约 16 小时的帧，上下文关闭超时，而测试断言本身已在约 12 秒内全部通过。用户停用 `systemd-timesyncd` 后连续采样无跳变，P25 及其余回归一次通过。当前系统时钟随 Windows 主机，比 NTP 时间约快 16 小时但保持稳定；Windows 时间设置未更改。

## 后续实际页面复测

Desktop 在独立模拟业务中通过同页侧栏右键归档合同任务负责人，周期页无需重载即显示“已归档”；恢复到同专业替代 Bot 后，原结果及历史版本保留。暂估计量下尝试完成复盘，页面显示“所需证据或前序任务结果尚未齐全”，人工演示草稿保留。F2/F3 的原页面复现路径均已通过，不只依赖隔离 E2E 的 RPC 归档场景。

本次没有捕获 F3 的 HTTP 响应，依据实际页面表现验收，不声称直接核实网络错误码。公开摘要见[修复收尾验收](eTraderBot-v1-acceptance.md#业务周期修复与定向复测收尾2026-11-05)；原始截图与报告保存在本机忽略目录，没有作为新的源码测试通过数累计。

## 未验证范围

- 同业务多周期的浏览器场景：现有接口每业务每时段只生成一个演示周期，既有夹具无法在同一页面构造两个周期，仅由单元测试覆盖，不计为浏览器已验证。
- F1 服务端校验映射只由单元测试覆盖：前端契约校验会先拦截超长输入，浏览器无法自然产生该服务端拒绝；原浏览器请求的实际拒绝原因未重新捕获。
- 非日前阶段的申报证据只由单元测试覆盖显示；浏览器 P25 只产生日前申报。
- F2 隔离浏览器用例经 RPC 归档（依靠名单轮询反映）；同标签页侧栏右键菜单的实际页面复测已在后续验收补齐，见上节。
- F3 浏览器只自然触发了 `MISSING_EVIDENCE`；`STALE_DATA`、`FORBIDDEN`、`NOT_FOUND` 文案只由单元测试覆盖。其他语言（非中英）的拒绝文案未翻译，回退英文，与仓库惯例一致。后端对同所有者、跨业务等拒绝情形由后端测试覆盖，前端只展示其错误，未逐项浏览器验证。
- 未运行 Electron E2E（按 AGENTS.md 不在本机常规运行）、移动端、全仓 CI；真实模型协作与真实交易接口不属于本轮验证。
