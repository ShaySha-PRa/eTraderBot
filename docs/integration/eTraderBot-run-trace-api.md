# 02 运行追踪最小接口

契约：`packages/contracts/src/run-trace.ts`，由 `@rakazo/contracts` 导出。复用 `appContract.runs`；原 `runs.list` 不变。后端持久化、查询及隔离回归已完成，前端使用此契约接入；实现及验证边界见 [02 后端记录](../implementation/eTraderBot-foundation-02-run-traceability.md)。

## 查询

- `runs.forTicket({ ticketId, limit?: 1..100, cursor?: { runId, createdAt } })` → `{ runs: RunTraceRow[], nextCursor: { runId, createdAt } | null }`。默认 20 条，按 `createdAt DESC, id DESC`；同一工单的多次派单和相关重试分别显示。只用持久化 Task→Ticket 关联；不解析标题、prompt 或评论猜测旧关联。空列表应显示“未记录关联运行”，不能推断从未运行。
- `runs.detail({ runId })` → `RunTraceDetail`。包含同一行信息、`ticket | null`、`waiting | null`、`timing`、`usage`、`toolTrace`。Ticket 业务状态与 Run 状态独立展示；Run 完成不代表工单完成。

`RunTraceRow` 字段：`runId, taskId, botId, botName: string|null, threadId, status, trigger, createdAt, startedAt: string|null, completedAt: string|null, retryOfRunId: string|null, reason`。时间都是 ISO 时间。`reason` 是共享枚举的安全分类，直接用于前端翻译，不是原始错误文本；未记录原因为 null。等待与停止来自持久化状态，失败分类使用已有错误分类器，无法分类但有错误时为 `failure`。不返回原始 prompt、provider error、工具输入输出或凭据。

## 详情空值与展示

| 字段 | 含义 |
| --- | --- |
| `ticket: {id, ref, title, status} \| null` | 可访问的持久关联。null 显示“未记录工单关联”；历史未关联或工单已删除均不猜测补写。 |
| `botName: string \| null` | 当前可读名称；缺失显示未记录。Bot 删除仍遵守现有级联策略，已删除 Run 返回 NOT_FOUND，不承诺新建永久保留机制。归档 Bot 的现存 Run 仍可读。 |
| `waiting: {kind: 'input'\|'takeover'} \| null` | 分别对应 waiting_input／waiting_takeover；不包含问题或登录内容。 |
| `timing.queuedMs / durationMs / firstResponseMs` | 分别为 started−created、completed−started、firstResponse−created。仅使用持久时间戳；任一端缺失返回 null，不能以当前时间伪造完成耗时。 |
| `usage.recordCount` | 此用户、工作区、runId 的用量记录数；不混入其他 Run 或子 Run。 |
| `usage.totalTokens` | 有记录且每行 totalTokens 都已知才汇总，否则 null。 |
| `usage.costUsd / costKnown` | 有记录、每行均为 USD 且 costUsd 有值才汇总/true，否则 null/false。明确记录 0 才是零；缺失不能算零。运行中只代表已记录用量，不代表最终账单。 |
| `toolTrace.recorded` | 从首次执行起启用捕获的标记。旧 Run 为 false，显示“未记录工具摘要”；不能把 calls=[] 显示成没有使用工具。旧 Run 恢复后可能有部分 calls，仍为 false；应保留提示并展示已记录部分。true 也不代表每条工具已有确定终态，应继续判断 pending/ambiguous/truncated。 |
| `toolTrace.calls` | 最多 200 条，按开始时间和 ID 升序；每条 id、attemptId、name、status、startedAt、finishedAt、durationMs，以及下节的可空 resultSummary。无原始输入输出。 |
| `toolTrace.truncated` | true 表示超过上限，页面明确提示仅展示部分；不当作完整列表。 |

工具状态：`pending` 正在处理；`waiting` 等待批准/输入，尚未确认执行；`completed` 工具返回完成；`failed` 工具返回错误；`refused` 准入拒绝；`ambiguous` 调用结束结果未可靠记录，或 Run/attempt 已结束、租约已更替但调用仍没有终态。不能把停止理解为已发出外部操作撤回。每次 attempt 分别记录，恢复时不覆盖先前调用；等待记录仍描述当时的准入结果，不因后续批准而改成完成。未知工具名显示安全标识 `unknown_tool`，不回显模型传入的任意字符串。

工具 finishedAt 是本次准入/调用返回的时间，不保证外部业务已最终完成。终态写入失败不会重试已执行操作；未完成记录在运行仍有效时保留 pending，在运行或 attempt 终结/租约更替后按 ambiguous 返回，且不伪造完成时间。

## 08 普通聊天与安全结果摘要

普通聊天可通过 `ThreadMessage.runId` 查询同一 `runs.detail`，即使 `ticket:null`。旧消息没有 runId、记录不完整、缺少结果时保持“未记录”；原消息 steps 仅名称与次数，不能猜测每个 step 对应哪个 call。可按 Run 展示实际调用列表，不能根据 Run completed 或 Bot 回复推断工具成功。无返回结果、丢失终态、租约失效等结果未知情形为 ambiguous。

兼容新增字段 `toolTrace.calls[].resultSummary?: SafeReadonlySourceSummary | null`，类型从 `@rakazo/contracts` 导出，新 API 始终返回字段，optional 用于兼容旧 API / 既有 mock。只对实际解析的 MCP `read_synthetic_load` 调用生成；其他工具保持 null。摘要随调用结果持久化，刷新可回读，不重复执行。

- 成功：`{kind:"readonly_source",schemaVersion:1,outcome:"success",source:{kind:"synthetic",sourceId:"synthetic-load-example",workspaceId,version:"synthetic-load-v1",generatedAt,timezone:"Asia/Shanghai"},date,candidateOnly:true,periods:[{start,end,forecastMWh}]}`。仅配合 completed 返回。
- 源失败：`{kind:"readonly_source",schemaVersion:1,outcome:"error",workspaceId,errorCode,retryable}`。仅配合 failed 返回；code 是 `INVALID_QUERY|SOURCE_TIMEOUT|SOURCE_UNREACHABLE|SOURCE_INVALID_RESPONSE|SOURCE_AUTH_FAILED|SOURCE_NO_DATA`，不能携带任意文本。MCP 传输失败不保证有源侧错误码，因此可能只有 failed、摘要 null。
- 缺失、旧记录、非法结构 / 范围 / 长度、refused 或 ambiguous：null。不补猜来源或结果。旧 Run `recorded:false` 即使有部分新 calls 也保持历史不完整提示。

写入及读回均投影白名单，固定枚举以外不接收任意描述；workspaceId 最长 128 且须匹配当前 Run 业务，ISO 日期 10 字符、时间最长 35 字符，最多 24 时段，有限非负数值、时段边界校验，JSON 最多 8 KiB。凭据、参数和原始错误 message 不进入显示摘要。新迁移仅添加可空 JSONB 列及数据库长度约束，不改写旧记录。

当前用户和业务权限不变。按用户 / 业务 / runId 隔离前端缓存，切换或撤权时不保留旧业务展示；使用原线程事件刷新、展开详情轮询兜底。前端工作交原 Claude，不能把本后端验证写成浏览器验收。详见 [08 补充交付](../implementation/eTraderBot-foundation-08-tool-display-backend.md)。

## 权限、错误和前端协作

后端重查当前工作区成员资格、Run 的 userId 和 spaceId。工单列表只返回调用者自己的可读 Run，不因看板可见而暴露他人的运行。越区或不存在资源统一 `NOT_FOUND`，无当前成员资格 `FORBIDDEN`；ORPC `data.reason` 同名。遵循现有租户隔离，不放宽 Bot 的交易或审批权限。

不新增订阅协议：复用原看板／线程运行事件触发查询失效，并对打开的运行详情做现有 Query 轮询补偿。展示时区沿用业务要求 Asia/Shanghai。Web/Electron 共用前端；移动端若本轮不提供原生入口，记录明确降级。

CLI 负责 contracts、db、adapters、API、隔离回归；Claude 负责 Web 展示、查询接入、中英文及窄屏验证。CLI 不运行浏览器，集成测试使用独立 Testcontainers 数据库和 API/Web 配置端口 3551/5621。不得使用 Desktop 现有验收库、附件或测试结果目录。04/05 不属于本轮，不提交或推送。
