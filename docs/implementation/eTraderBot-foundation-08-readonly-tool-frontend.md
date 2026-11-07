# 08：标准只读样例的前端配合与验证

2026-11-07；工作树 `platform-foundation`，分支 `feat/platform-foundation`。依据 08 交接（本地证据 `.scratch/etraderbot-foundation/coordination/08-readonly-tool-example.md`，不在仓库中） 与 [接入说明](../integration/eTraderBot-readonly-tool-example.md)。只改 Web 前端和测试；不改后端、契约、04/06 文件。未提交、推送或关票，未启动 09。

## 核实结论

| 要求 | 现有能力 | 处理 |
| --- | --- | --- |
| 先禁用、限定 Bot、再启用 | **缺口**：添加表单在选择部分 Bot 时以 `enabled:true` 创建，再缩小授权，中间短暂对全部 Bot 可用 | 已修复（见下） |
| 保留其他连接分配 | 页面使用按连接的 `mcp.servers.agents`，不调用全量替换的 `assignments.replace` | 已有，补验证 |
| 凭据不回显 | 密码输入；编辑时字段为空、占位“已加密保存”；列表只有 `hasSecret` | 已有，补验证 |
| 切换业务不复用旧连接/Bot 选择 | 切换业务时整个 Shell 以新 key 重建，弹窗表单与选择不保留；查询按用户+业务分键 | 已有，补验证 |
| 展示 structuredContent 字段 | **缺口（需契约）**：聊天消息只保存 `steps`（工具名+次数），没有任何工具结果正文；页面无从读取 structuredContent | 交回 CLI |
| 失败/撤销拒绝不显示为成功 | **缺口（需契约）**：`steps` 没有状态字段，所有已完成步骤都显示绿色 ✓，失败或拒绝的调用与成功看起来相同 | 交回 CLI |
| 390 px 中文 | **缺陷**：MCP 列表在 390 px 下名称被挤为零宽、状态逐字换行、操作按钮溢出 | 已修复 |

## 修改

- `McpServersOverlay.tsx`：选择部分 Bot 添加连接时，按 `create(enabled:false)` → `servers.agents({allBots:false, botIds})` → `servers.update(enabled:true)` 顺序；启用请求不回传凭据（`secret` 省略、header/env 值留空表示保留）。授权或启用失败时，表单停在已保存且仍禁用的连接上，再次保存完成授权和启用，不重复创建。选择全部 Bot 时保持原来一步创建。
- 同文件：连接卡片在窄屏换行，名称保留宽度，控件（可用业务、Bot、OAuth、操作）移到下一行并可换行。
- 无新增文案。

## 验证

- 单元：`McpServersOverlay.test.tsx` 新增 3 项（部分 Bot 的创建顺序及启用不带凭据；全部 Bot 一步创建；授权失败后再次保存完成且不重复创建），前两项在原实现上失败；共 18 项通过。Web 全部 186 个文件 1780 项通过；`tsc`、Biome 通过。
- 隔离 Playwright（Testcontainers 新库，`API_PORT=3310 WEB_PORT=5380`）新增 `e2e/mcp-readonly-example.spec.ts` 1 项通过：
  - 业务 A 已有一个分配给复盘 Bot 的其他连接。在页面添加“Synthetic readonly example”，填写合成凭据，只选风控 Bot。实际请求依次为 create（`enabled:false`）、agents（`allBots:false`、仅目标 Bot）、update（`enabled:true`，不含凭据）；所有 MCP 响应和页面不含凭据；服务端列表为 `enabled:true`、`allBots:false`、`hasSecret:true`，新连接只分配给目标 Bot，原连接对复盘 Bot 的分配仍在。编辑时凭据输入为空。
  - 切换中文并实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`）：连接名称宽度大于 120 px，操作按钮在弹窗内，页面无横向溢出。
  - 切换到业务 B：服务端列表和页面都不含 A 的连接。
- 既有 `mcp-stdio`、`direct-mcp-integrations`、`mcp-agents`（2）浏览器用例在修改后通过。
- 截图：`.scratch/etraderbot-foundation/evidence/08-readonly-config/`。

## 未验证与限制

- 浏览器测试环境把所有 MCP HTTP 交给共享的第三方连接器模拟器，它不能访问本地样例进程；为一个样例改共享测试工具违反仓库规则，因此浏览器用例使用模拟器地址，只验证配置、授权、凭据和业务隔离，**未验证真实样例的工具发现、调用、结果或失败**。
- 测试环境的确定性运行时不会调用 MCP 工具，未在浏览器中完成对话调用；CLI 的 HTTP/数据库测试使用自带运行时，不能替代页面验收。
- 结构化结果展示、失败/拒绝区分为契约缺口（下节），当前页面无法满足；在补齐前，失败只能从 Bot 回复文字或（仅工单运行）看板运行详情中的工具状态看出。
- 未运行 Electron、原生移动端、真实模型；移动端没有 MCP 配置入口。

## 交回 CLI 的契约问题

1. **工具结果不可见**：聊天 `steps` 只有名称与次数，`structuredContent`（source.kind / workspaceId / version / generatedAt、date、periods、candidateOnly）不进入任何前端数据。若需页面展示，需后端决定以安全、限长、字段白名单的形式随消息或运行记录持久化（不含凭据、不含原始错误正文），并定义前端契约；前端再按通用方式渲染。
2. **步骤没有结果状态**：`steps` 缺少 completed / failed / refused 区分，页面对所有已完成步骤显示 ✓。建议在 `steps` 项或运行工具记录中提供安全的状态枚举，前端据此显示失败与拒绝，不显示为成功。

## Desktop 独立验收

需要按接入说明在独立应用实例（`MCP_ALLOW_PRIVATE_ENDPOINT=true`）启动样例，**不能用本浏览器测试环境**：

1. 在页面添加样例连接，只选目标 Bot，确认网络为 create(enabled:false) → agents → update(enabled:true)，其他连接分配保留，页面与响应无明文凭据，连接显示 1 个工具。
2. 切换业务，确认看不到 A 的连接与 Bot 选择。
3. 用真实模型请求 2026-11-08 合成负荷：核对 Bot 回复与运行记录；页面目前只显示工具步骤，**看不到 structuredContent 字段**（上节第 1 项）。
4. 撤销分配或停用源、查询 2026-11-09、停止 source：核对后端拒绝/错误；页面步骤仍显示 ✓（上节第 2 项），失败需从回复文字或运行记录判断。
5. 中英文 390 CSS px 下检查 MCP 列表可读、控件不溢出。

## 补充：聊天中的实际调用状态与安全摘要（2026-11-07）

依据 08 交接顶部的“聊天状态与安全摘要补充契约”。只改前端、翻译和测试；未改后端、契约、迁移或 04/06 文件。

### 行为

- 聊天中已完成的工具卡片被打开时，用消息的 `runId` 调用 `runs.detail`，列出该 Run 实际记录的每次调用及其状态（进行中 / 等待批准 / 完成 / 失败 / 已拒绝 / 结果未知）。只读取一次（打开后），运行中的卡片不读取；一条消息有多个步骤卡片时只在最后一个显示，避免重复。
- 步骤行不再用绿色 ✓ 表示成功，改为中性圆点：步骤只说明用过某工具，结果以记录为准。不按工具名把步骤与调用对应。
- 调用带 `resultSummary` 时可展开：成功显示“合成 · sourceId”、业务 ID、版本、生成时间（上海时间）、日期、各时段及 MWh，以及“仅为候选资料，未记录为业务证据”；失败按稳定错误码翻译（6 个代码），并说明是否可重新请求，不显示源原文。`undefined` / `null` 不展示摘要；`recorded:false` 显示“未记录工具摘要”，`truncated` 显示仅部分；多次尝试按 04-D1 的尝试分组保留。
- 工具摘要渲染从 `TicketRuns.tsx` 移入共用 `components/run-tool-trace.tsx`，看板运行详情同样显示摘要。
- 刷新：线程的运行终止和等待事件使对应 `runs.detail` 失效；运行或调用未结束时 5 秒轮询，结束即停。查询键含用户、业务与 runId；切换业务时整个 Shell 重建，撤权按 05 离开该业务，旧摘要不再显示。
- 新增 16 条文案（zh-CN/zh-TW 已翻译）。

### 验收库与迁移

浏览器验证由 E2E 测试框架新建独立 Testcontainers 数据库，并按标准迁移流程应用全部迁移（含 `20261201120000_run_tool_result_summary`）；`pnpm --filter @rakazo/db generate` 已重新生成 Prisma client（已含该列）。未连接或迁移任何原业务库或 Desktop 验收库。

### 验证

- 单元：新增 `run-tool-trace.test.tsx` 6 项（成功摘要字段；失败按代码翻译并随语言切换、不显示为完成；已拒绝无摘要且保留各尝试；缺摘要 / 未记录 / 截断；读取失败可重试而 NOT_FOUND 不重试；未结束时轮询、结束后停止）；`ToolActivityDisclosure.test.tsx` 新增 2 项（仅在打开已完成卡片时读取；运行中或无 runId 不读取）并更新步骤标记断言；相关测试的模拟补充 `runs`。Web 全部 187 个文件 1788 项通过；`tsc`、Biome 通过。
- 隔离 Playwright（`API_PORT=3310 WEB_PORT=5380`）新增 `e2e/chat-tool-result-summary.spec.ts` 1 项通过：在业务 A 与主管聊天产生真实 Run 与真实工具调用（`update_bot`）；随后在该测试库为此 Run 写入三条只读源调用记录（失败 + 错误摘要、完成 + 成功摘要、已拒绝无摘要）。**这三条记录是构造的持久化数据，页面经真实 `runs.detail` 读取；不是实际 MCP 调用的证据。** 英文下核对各状态和展开内容；中文、实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`）下核对翻译和无横向溢出；切到另一业务后页面不显示摘要，且以该业务身份请求此 Run 得到 404；回到业务 A 可见，再在测试库删除成员资格后刷新，页面离开 A 并提示，摘要不再显示。
- 受影响页面回归：`tool-activity`（2）、`board-run-trace`（3）、`chat-progress-messages`（1）通过。
- 截图：`.scratch/etraderbot-foundation/evidence/08-tool-summary/`。

### 实际调用与模拟数据的边界

- 页面层只用构造记录验证了展示、翻译、隔离与撤权；真实 MCP 调用写入摘要由 CLI 的隔离 PostgreSQL 测试证明。浏览器测试环境的连接器模拟器和确定性运行时无法产生真实只读源调用（见上文），完整链路需 Desktop 在独立实例用真实模型验收。
- 工具卡标题“1 个工具”来自步骤计数，与记录中的调用数可能不同（构造数据时尤其如此）；状态以记录为准。
- 旧调用没有摘要属于预期，未重放历史工具补数据。
- 未运行 Electron、原生移动端。

### Desktop 独立验收（补充）

在独立实例应用新增迁移并更新 Prisma client 后：

1. 用真实模型查询 2026-11-08：打开聊天中的工具卡片，核对调用为“完成”，展开来源详情核对合成来源、业务 ID、版本、生成时间、两个时段（12.5 / 13.5 MWh）及候选标记。
2. 查询 2026-11-09 应显示“失败”及“数据源没有该请求的数据”；停止 source 后应为“无法连接数据源”并提示可重新请求；撤销分配后的调用应为“已拒绝”且无成功摘要。
3. 切换业务、撤销成员资格后不显示原业务摘要。
4. 中英文 390 CSS px 下复核；旧消息无摘要时只显示状态。

## 08-D1 修复：工具卡片折叠标题（2026-11-07）

Desktop 报告：同一 Run 两次调用同一 MCP 工具（一成功一失败）时折叠标题写“完成 2 个工具”；撤权后没有任何 MCP 调用的 Run 仍写“完成 1 个工具”；单次失败外层也写“完成”。数字是步骤计数，不是工具数或调用数，“完成”会让失败看似成功。

- 已完成卡片的折叠标题改为中性的“工具活动 / Tool activity”，只保留耗时；运行中为“处理中…”。不再显示任何数量，也不再显示“完成”。各次调用的真实状态、尝试分组、失败、无记录（“未记录工具调用”/“未记录工具摘要”）照旧由运行记录展示；不对应步骤与调用。
- 删除仅用于该数量的 `stepCount` 参数及 `toolStepCount` 函数（无其他使用方）。新增文案 1 条（zh-CN“工具活动”、zh-TW“工具活動”）。

验证：

- 单元：`ToolActivityDisclosure.test.tsx` 更新——已完成标题为“Tool activity + 耗时”且不含 Done 或数量；运行中为“Working…”且不含数量；其余既有行为不变。Web 全部 187 个文件 1786 项通过（删除 `toolStepCount` 及合并标题用例后数量减 2）；`tsc`、Biome 通过。
- 隔离 Playwright：新增 `e2e/chat-tool-activity-header.spec.ts` 1 项通过。与主管聊天产生 3 个真实 Run（各有真实步骤）；在测试库将三者的工具记录按报告形态构造为：同一只读工具两次（完成 + 失败）、单次失败、无任何调用记录。**记录为构造数据，页面经真实 `runs.detail` 读取。** 实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`），英文和中文下三张卡片标题均为“Tool activity / 工具活动”且不含数量或完成；展开分别显示完成+失败、仅失败、“未记录工具调用”。既有 `tool-activity`（2）按新标题更新后通过，`chat-tool-result-summary`（1）通过。
- 截图：`.scratch/etraderbot-foundation/evidence/08-D1-tool-activity-header/`。

边界：真实双调用 / 撤权无调用的数据形态以 Desktop 报告和 CLI 测试为准，本次浏览器用构造记录；未运行 Electron、原生移动端。08-D2（中文名称派生 slug 冲突）不在本次修改中；当前工作树 `packages/core/src/mcp.ts` 已有非 ASCII 名称追加哈希的实现（非本会话修改），请 Desktop 一并复测。

Desktop 复测：在报告的三个真实 Run 上打开聊天，折叠标题应为“工具活动 + 耗时”，不出现“完成”或数量；展开分别核对完成+失败、单次失败、“未记录工具调用”。中英文 390 CSS px。

## 08-D2 前端提示：连接标识冲突（2026-11-07）

CLI 已修复共享 slug 生成（`packages/core/src/mcp.ts`，本次未改）。前端只为交接中两条明确的 MCP 标识冲突消息提供本地化提示。

- 新增 `lib/mcp-identifier-conflict.ts`：仅当错误码为 `CONFLICT` 且消息恰为 `An MCP server with that identifier already exists.` 或 `An MCP server with that identifier already exists in one of these spaces.` 时，显示“已有连接使用此标识，请更换名称或使用现有连接”（zh-TW“已有連線使用此識別碼，請更換名稱或使用現有連線”）。其他 CONFLICT（如凭据修订冲突、技能同名）和非 CONFLICT 错误保持原有显示；不建议删除旧连接。
- MCP 添加/编辑表单与“可用于”业务范围控件（仅 `mcpServer` 类型）使用该提示；两处都保存失败本身、渲染时取文案，随界面语言切换。表单输入保留。任何后续操作的新结果会替换旧的保存失败提示。
- 新增文案 1 条。

验证：

- 单元：`mcp-identifier-conflict.test.ts` 3 项（两条消息均识别；随语言；其他冲突、相同文字但非 CONFLICT、网络错误不识别）；新增 `space-availability.test.tsx` 2 项（MCP 显示标识冲突提示；技能保留自身消息）；`McpServersOverlay.test.tsx` 新增 1 项（标识冲突提示且表单保留、无删除引导；随后另一类 CONFLICT 显示原消息）。Web 全部 189 个文件 1792 项通过；`tsc`、Biome 通过。
- 隔离 Playwright 新增 `e2e/mcp-identifier-conflict.spec.ts` 1 项通过：先以同一派生标识建好一个连接，再在中文、实测 390×844（`innerWidth=390`、`clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`）的页面添加同名连接；服务端实际返回 409，页面显示上述提示、不显示英文原文，名称与地址保留，无横向溢出。受影响的 `mcp-readonly-example`（1）、`mcp-agents`（2）、`chat-tool-activity-header`（1）通过。
- 截图：`.scratch/etraderbot-foundation/evidence/08-D2-identifier-conflict/`。

边界：业务范围控件的跨空间冲突（第二条消息）只由单元测试覆盖，浏览器用例覆盖的是数据库唯一约束（第一条）；未重跑真实 MCP 调用流程。未运行 Electron、原生移动端。

Desktop 复测（D2）：刷新页面加载新代码后，以已占用标识的名称添加连接，应显示“已有连接使用此标识，请更换名称或使用现有连接”，输入保留；在多个业务间调整“可用于”遇到同标识时显示同一提示；其他错误不受影响。中英文 390 CSS px。
