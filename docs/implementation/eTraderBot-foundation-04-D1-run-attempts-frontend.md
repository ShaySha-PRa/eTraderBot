# 04-D1：恢复运行的工具历史按尝试归属展示（前端）

2026-11-07；工作树 `platform-foundation`，分支 `feat/platform-foundation`。依据 04 交接（本地证据 `.scratch/etraderbot-foundation/coordination/04-run-recovery.md`，不在仓库中） 的“原 Claude：04-D1 页面修复”与 Desktop 报告（本地证据 `.scratch/etraderbot-foundation/acceptance/runs/accept-04-20261107-dc742a/report.md`，不在仓库中）。02 不重开。只改 Web 前端、翻译和测试；不改后端、契约、04 新 Claude 或 CLI 06 登记的文件。未提交、推送或关票。

## 问题

恢复后的运行详情里，同名 `business_cycle` 调用平铺为 Result unknown · Done · Refused，看不出完成属于恢复尝试，未知和迟到拒绝属于旧尝试；最后一行 Refused 容易被当成最终结果。

## 行为

- 运行详情的工具摘要使用接口已有的持久化 `attemptId` 分组：当调用来自两个及以上尝试时，每个尝试一组，标题为“尝试 #编号”（attemptId 末 8 位，可访问名称“尝试 {编号}”），各组按该尝试第一条调用的开始时间排序，组内按调用开始时间排序。
- 分组时每条调用显示开始时间（Asia/Shanghai，到秒），迟到的拒绝在旧尝试组内仍能看出发生在恢复之后。
- 所有状态原样保留：Result unknown、Done、Refused 都不删除、不改写；运行状态与工单状态仍各自来自运行与工单，不由最后一条工具调用推断。
- 只有一个尝试时保持原来的平铺列表，不增加标题。
- 02 的完整 Run ID、未知/缺失记录语义、刷新、错误重试保持不变。
- 新增文案 2 条（`Attempt`、`Attempt {code}`，zh-CN/zh-TW 已翻译）。

不从现有契约猜测的语义：接口只提供每条调用的 `attemptId`，没有尝试的状态、序号或“哪个尝试完成了运行”。因此页面不把任何一组标成“恢复尝试”“旧尝试”或“最终”，只按持久化归属和时间排列；若需要显示尝试结果，应由后端在契约中提供后再展示。

## 验证

- 单元：`TicketRuns.test.tsx` 新增 2 项，用 Desktop 报告中的实际形态（两条 attemptId；未知 → 完成 → 旧尝试迟到拒绝）检查分为两组、旧组依次为结果未知和已拒绝、新组为完成、调用开始时间按上海时间显示、可访问名称随语言切换；单一尝试仍为平铺列表。共 12 项通过；Web 全部 186 个文件 1774 项通过；`tsc`、Biome 通过。
- 隔离 Playwright（Testcontainers 新库，`API_PORT=3310 WEB_PORT=5380`）`e2e/board-run-trace.spec.ts` 3 项通过（含 02 原有 2 项）。新增用例：在看板创建工单，唤醒得到真实完成的运行；随后在该测试库为该运行写入一个更早的 `interrupted` 尝试，并按 Desktop 形态写入工具记录（旧尝试 ambiguous、真实尝试 completed、旧尝试迟到 refused）。**这些尝试和工具记录是测试库中构造的持久化数据，页面是真实页面读取，不是恢复流程本身的证据。** 实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`），英文和中文下按可访问名称找到两个尝试组，核对各组状态、组顺序、完整 Run ID，详情和页面无横向溢出。
- 截图：`.scratch/etraderbot-foundation/evidence/04-D1-run-attempts/`（英文、中文）。

## 限制

- 页面数据为构造的持久化记录；真实恢复流程的数据形态以 Desktop 报告和 04 测试为准。
- 尝试编号为 attemptId 末 8 位，理论上存在极低的碰撞概率。
- 未运行 Electron、原生移动端。

## Desktop 复测

在最终冻结版本上，用 04 恢复完成的隔离测试库打开看板 → RAK-1 → 运行 → 恢复后的运行详情：

1. 工具摘要应分为两个“尝试 #编号”组；旧尝试组含“结果未知”和后来的“已拒绝”，另一组含“完成”；编号与数据库 `run_tool_calls.attempt_id` 末 8 位对应。
2. 运行与工单仍显示完成，所有历史状态都在。
3. 中英文、390 CSS px 下复核无横向溢出；普通单尝试运行仍为平铺列表。
