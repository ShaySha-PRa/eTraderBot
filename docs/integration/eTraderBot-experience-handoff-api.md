# 固定版本经验交接 MVP：前端接口交接

共享契约：`packages/contracts/src/experience-handoff.ts`，RPC 命名空间
`experienceHandoff`。所有调用使用现有登录会话及 `x-rakazo-space-id`，无需新客户端。
共享层、API 和运行时适配及 Web/Electron 共用页面已接入；页面入口与验证边界见
[前端记录](../implementation/eTraderBot-experience-handoff-frontend.md)。移动端暂不提供交接操作。

## 调用顺序

| RPC | 工作区上下文 / 输入 | 返回及用途 |
|---|---|---|
| `catalog` | 源区；`sourceBotId` | 可选资料的 `id,kind,sourceType,title,revision`；不是全选 |
| `create` | 源区；`requestId,sourceBotId,title,applicability,summaries,memories,skills`，可选 `previousPackageId` | 不可变交接包、版本、内容哈希 |
| `packages` | 当前有权工作区；`limit?,cursor?` | 同用户当前有权源区的交接包；用于跨业务选择 |
| `get` | 当前有权工作区；`packageId` | 完整固定快照；再次验证源区权限 |
| `preview` | **目标区**；`packageId,targetBotId,plan?` | `package,plan,previewHash,conflicts,alreadyImported`，不写入目标 |
| `confirm` | **目标区**；`packageId,targetBotId,plan,previewHash` | 原子导入回执；冲突必须返回预览处理 |
| `history` | 源或目标区；`botId?,limit?,cursor?` | 导入回执和来源；Bot 删除后仍能按原 ID 查询 |
| `importDetail` | 源或目标区；`importId` | 导入当时的包快照与回执；目标保留已授权副本，无需再次获得源区访问权 |
| `revoke` | 源区；`packageId` | 禁止后续导入；不撤回已形成的独立副本 |
| `skills` | 目标区；`botId` | 交接 Skill 副本，包括待启用项 |
| `updateSkill` | 目标区；`skillId,expectedRevision,content?,enabled?` | 编辑/启停独立副本；不授予工具、算法或交易权限 |

`applicability={conditions:string[],limitations:string[]}`：适用条件必须至少一项，
由用户确认；服务端不声称自动判定跨业务适用性。
`summaries=[{title,content}]` 是用户明确选择/确认的总结文本，不自动导出整段聊天。
`memories/skills=[{id,revision}]` 使用 catalog 返回的版本，创建时若已变化则冲突。
Skill 指本区持久化的 SKILL.md 及文本附件，也可再次选择本 Bot 的交接 Skill 副本；不包含演示录制、插件安装、连接或凭据。
原生记忆为本批支持范围；外部记忆提供方不以本地缓存冒充权威内容，相关写入安全拒绝。

## 目录来源类型（2026-11-05 补充）

`catalog[].sourceType` 为服务端返回的必填稳定枚举，不能从名称、路径或 ID 推断：

| `kind` | `sourceType` | 前端含义 |
|---|---|---|
| `memory` | `bot_memory` | 本 Bot 记忆：当前所选 Bot 的专属记忆 |
| `memory` | `shared_memory` | 共享记忆：源工作区内该用户的共享记忆，不是跨用户共享 |
| `skill` | `workspace_skill` | 源工作区的 SKILL.md |
| `skill` | `imported_skill` | 本 Bot 的交接 Skill 副本 |

同名 `MEMORY.md` 也根据 `sourceType` 区分，其他 Bot 的专属记忆不会出现在目录。
已复制到本 Bot 的记忆按当前归属显示 `bot_memory`，历史来源仍看交接包和回执。
新增共享导出：`HandoffCatalogEntrySchema`、`HandoffCatalogSourceTypeSchema` 及对应类型。
前端发起 `create` 时继续只提交选中的 `{id,revision}`，无需回传来源类型。

此字段仅属于实时目录，不加入 `snapshot.items`，不改变包的 `schemaVersion=1`、
内容哈希、资料哈希或请求哈希，不需要数据迁移/回填。旧包可以照常读取、预览、
确认和查看历史；不能用当前目录推断或补写旧包当时未记录的作用域。
若前端仍连旧版本服务、响应缺少该字段，应显示通用“记忆/Skill”而不是猜测来源。

## 版本、冲突和空值

- 新包 `version=1`；指定 `previousPackageId` 创建同源 Bot 的下一份完整快照。
  旧包不改动；旧版本不能分叉覆盖已有后继。`schemaVersion=1` 是格式版本。
- `requestId` 是创建幂等键。同用户重复同请求返回原包；复用键但改输入返回冲突。
- 默认预览为每项生成独立目标名称。`plan` 中每项必须恰好出现一次：
  `{itemKey,action:"copy"|"skip",targetName}`。记忆/总结名称为相对 Markdown 路径，
  Skill 为名称。存在同名资源时，只支持显式改名或跳过，**没有覆盖操作**。
- 将返回的完整 `plan` 与 `previewHash` 原样提交；修改方案后先重新预览。
  目标变动造成预览失效时返回 `CONFLICT`，需要再次预览。
- 同一包版本到同一个目标 Bot 仅导入一次。重复确认相同方案返回同一回执，
  包括响应丢失后的重试；不同方案冲突。事务失败不留下部分副本，可重试。
- `alreadyImported=null` 表示未导入；非空时显示已有回执，不再次创建资源。
  `previousPackageId=null` 为首版；`revokedAt=null` 为未撤销；
  历史详情中的 `package.revokedAt` 是导入当时状态，当前撤销状态看 `get/packages`。
  `enabledAt=null` 为 Skill **待启用/已停用**。`blockedReason=null` 表示无名称冲突；
  `name_conflict` 表示启用后有共享 Skill 占用了同名，运行时暂停加载该副本，
  需在共享 Skill 侧改名或移除冲突后恢复，不静默替换内容。
- 回执 `targetId/initialRevision=null` 仅用于显式跳过项；其他项分别为
  MemoryDocument / 交接 Skill 的独立 ID 和初始版本。Skill 回执 `status=pending`
  表示导入当时状态，后续启停查看 `skills`，历史回执不改写。
- `sourceId=null` / `sourceRevision="user-selected"` 用于用户确认的总结，不代表已核验的聊天消息 ID。
  非 Skill 项的 `description/files=null`；Skill 无附件时 `files={}`。
- 导入不随源编辑同步。目标记忆用现有 `memory.update` 编辑，Skill 用
  `updateSkill` 编辑；交接 Skill 对 Bot 工具只读，启停和编辑由用户发起。
  包/导入记录保留原文与来源，不因 Bot 删除而级联删除。

## 权限及错误

仅当前用户拥有并管理的源、目标工作区和 Bot 可操作；每次预览/确认都重新验证
源和目标权限，拒绝其他用户、撤销访问、迁移未完成的工作区及归档 Bot。
这是用户主动确认的复制授权，不开放 Bot 跨区工具，也不复制只读授权。
交接 Skill 仅在目标 Bot 中经用户启用后参与运行，其他 Bot 不可见。
凭据、连接配置、模板角色、算法启用状态、交易审批和授权不在包字段中。
Skill 仅携带名称、说明、正文及文本附件，不继承可执行权限类 frontmatter。

错误遵循现有 RPC：`FORBIDDEN` / `NOT_FOUND` / `BAD_REQUEST` / `CONFLICT`，
`data.reason` 提供稳定业务原因。前端不能把失败显示成导入完成。
创建、确认、撤销、启停使用现有身份确认机制；收到
`IDENTITY_CONFIRMATION_REQUIRED` 时沿用已有确认流程再重试。
不自动重启 Bot，不触发 Run，也不自动提交交易。

## Claude 接入检查

源 Bot 选择资料 → 确认适用条件 → 保存包；切换目标业务及 Bot → 预览 →
显示冲突并改名/跳过 → 明确确认 → 显示回执/待启用 Skill → 查看历史。
不要把跨区包目录当作当前 Bot 获得了源业务读取权限；目标副本权限独立。
接口仅新增命名空间，不改变原有 RPC、Bot、记忆或 Skill 的返回结构。

服务联调前需应用 `20261129120000_experience_handoff` 迁移并加载新代码；
本轮只在隔离 PostgreSQL 验证，未迁移开发业务库。验收见[后端记录](../implementation/eTraderBot-experience-handoff.md)。
