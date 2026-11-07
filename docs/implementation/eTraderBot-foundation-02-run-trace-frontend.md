# 02：工单运行追踪（前端）

2026-11-06；工作树 `platform-foundation`，分支 `feat/platform-foundation`。按 [正式接口说明](../integration/eTraderBot-run-trace-api.md) 接入 `runs.forTicket` 与 `runs.detail`；后端见 [02 后端记录](eTraderBot-foundation-02-run-traceability.md)。只改 Web 前端、翻译和测试；不改共享契约、服务端或数据库。未提交、推送。

## 行为

- 看板工单弹窗新增“运行”区：按接口顺序（新到旧）列出 Bot、运行状态、开始时间（固定 Asia/Shanghai 并标明 GMT+8）、重试运行标记和安全原因分类；“加载更早的运行记录”使用接口游标分页。空列表显示“未记录关联运行”，不暗示从未运行。
- 点开一条运行在原处显示详情：运行状态与工单状态分开显示（`RAK-1 · 待办`），Bot 链接到其聊天；开始时间、耗时、费用、工具摘要。“全部运行”返回列表。
- 空值不伪装：耗时缺失显示“未记录”；`costKnown=false` 显示“未知”而非 0；`toolTrace.recorded=false` 显示“未记录工具摘要”，同时保留已记录的部分调用；`recorded=true` 且无调用显示“未记录工具调用”；`truncated=true` 显示“仅显示前面部分工具调用”。工具状态 pending/waiting/completed/failed/refused/ambiguous 分别为进行中/等待批准/完成/失败/已拒绝/结果未知。
- 等待原因不重复显示（状态已写明“需要输入/需要接管”）；停止和失败分类显示对应短语。不显示原始错误文本。
- 刷新：看板实时事件到达时让运行查询失效；列表中有未结束运行、或打开的详情未结束时每 5 秒轮询，结束后停止；被拒绝（非可重试）错误停止轮询。
- 错误：失败文案在渲染时按界面语言生成；加载失败显示“无法加载运行记录”或“无法连接服务器”并提供“重试”；`NOT_FOUND`/`FORBIDDEN` 显示“此运行已不可用”/“你已无权访问”，不提供无效的重试。刷新失败时错误显示在已加载列表上方，旧数据保留。
- 新增 31 条文案（zh-CN、zh-TW 已翻译），提取差异只有新增。

## 移动端降级

移动端当前没有看板或工单界面，本票不新增原生入口；运行追踪仅在 Web/Electron 看板提供。Electron 复用同一 Web 页面。

## 验证

- 单元：`TicketRuns.test.tsx` 9 项（空态措辞、分页与上海时间、重试和原因、详情中工单/运行状态分离和 Bot 链接、未知费用与未记录工具不显示为 0/无、部分调用与截断、错误重试及语言切换、拒绝不提供重试、活动运行轮询至结束后停止、刷新失败保留旧列表），`Board.test.tsx` 14 项（新增：看板事件刷新已打开工单的运行列表；去掉失效调用后该用例失败）。Web 全部单元通过，`tsc` 与 Biome 通过。
- 隔离 Playwright（Testcontainers 新库，`API_PORT=3310 WEB_PORT=5380`，确定性脚本运行时）`e2e/board-run-trace.spec.ts` 1 项通过：在看板创建指派给 Bot 的工单，唤醒产生的真实关联运行出现在列表并轮询到完成；详情显示 `RAK-1 · To do`、Bot 链接、费用和工具；整页刷新后仍列出；切换中文并实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`）；路由注入一次 500 后显示“无法加载运行记录”，不显示原始文本，点“重试”恢复；中文详情无横向溢出。
- 截图：`.scratch/etraderbot-foundation/evidence/02-run-trace/`。

## 限制

- 脚本运行时的工单唤醒不调用工具、无费用记录，所以浏览器只覆盖了“未记录工具调用”和“未知”费用；有工具调用、ambiguous、截断、已知费用和重试运行由单元测试覆盖。
- 实时刷新用单元测试验证；浏览器验证的是轮询到完成和整页刷新。
- 未运行 Electron、原生移动端和真实模型。

## Desktop 定向复测

在独立测试库执行，不使用其他票的验收库。

1. 看板新建指派给 Bot 的工单，打开工单，确认“运行”列表出现该运行并更新到完成；整页刷新后仍在。
2. 打开详情：运行状态与工单状态分开；Bot 链接可进入聊天；费用无记录时为“未知”；旧运行显示“未记录工具摘要”。
3. 改派给另一个 Bot 后重新打开，确认出现第二条运行且按时间区分。
4. 断网或阻断 `runs/forTicket` 一次，确认中文错误和“重试”可恢复；访问他人或其他业务的运行应显示“此运行已不可用”且无重试。
5. 中文、英文及 390 CSS px 下检查列表与详情无横向溢出。

## 02-D1 修复：同一 Bot 的不同运行可辨认（2026-11-06）

Desktop 发现快速改派 甲→乙→甲 后，两条甲运行在列表和详情中同名、同状态、同分钟，无法区分（`.scratch/etraderbot-foundation/coordination/02-desktop-run-identification.md`）。只改前端，沿用现有 `runId` 字段，不改契约、服务端或数据库，也不依赖列表位置。

- 每条运行显示短编号 `#xxxxxxxx`：取 Run ID 末 8 位。该段是 ID 的随机部分，同一秒创建的运行也不同，且不随分页或排序变化；只加秒数不够，因为同秒运行仍可能相同。
- 列表行的可访问名称为“运行 {编号}，{Bot}，{状态}，{开始时间}”（英文 `Run {code}, {Bot}, {status}, {time}`），屏幕阅读器可区分每一行。
- 详情区域以“运行 {编号}”命名，标题显示 `运行 #编号`，并显示完整“运行 ID”，可与列表或日志逐字核对。重试运行显示“重试自 #原编号”，替代原来无法指明来源的“重试运行”标记。
- 开始时间加上秒（仍固定 Asia/Shanghai，标 GMT+8），只作为辅助信息。
- 文案：新增 4 条（`Run {code}`、`Run {code}, {botName}, {status}, {startedAt}`、`Run ID`、`Retry of #{retried}`，zh-CN/zh-TW 已翻译），移除本票此前新增、现已不用的 `Retry attempt`。

验证：

- 单元：`TicketRuns.test.tsx` 新增同 Bot、同一秒两条运行的用例（使用报告中的两个真实形态 ID），检查列表文本、可访问名称、详情区域名称及完整 ID 各不相同，并在中文下检查；修复前两行没有可访问名称，该用例无法通过。`TicketRuns` 10 项、`Board` 14 项、Web 全部单元 1765 项通过，`tsc`、Biome 通过。
- 隔离 Playwright（`API_PORT=3310 WEB_PORT=5380`）`e2e/board-run-trace.spec.ts` 2 项通过。新增用例：创建指派 Planner 的工单，连续改派 Reviewer、Planner，得到同一秒开始的三条运行（页面显示同一秒）；实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`），英文和中文下按可访问名称分别定位两条 Planner 运行，各自打开详情，确认区域名称和完整 Run ID 对应且不含另一条的 ID，详情和页面无横向溢出。
- 截图：`.scratch/etraderbot-foundation/evidence/02-D1-run-identification/`（列表、两条详情，中英文各一组）。

限制：编号是 Run ID 的末 8 位，理论上同一工单内两条运行末 8 位相同的概率极低；详情中的完整 Run ID 始终唯一。未运行 Electron、原生移动端。

Desktop 定向复测：在原业务 RAK-1（或新工单）快速改派 甲→乙→甲，打开“运行”：两条甲运行显示不同 `#编号`，屏幕阅读器读出的名称不同；分别打开详情，标题编号和完整运行 ID 应对应 `cmw5kh8h7000nc8qevfad2937`（`#vfad2937`）与 `cmw5khff2000xc8qels24cshc`（`#ls24cshc`）。中英文 390 CSS px 下复核。
