# 固定版本经验交接：Web 前端接入

按 [接口说明](../integration/eTraderBot-experience-handoff-api.md) 与 [后端实施记录](eTraderBot-experience-handoff.md) 接入 Web／Electron 共用页面。前端实施阶段没有修改共享契约、后端服务或权限逻辑；本次与后端功能和补测一起整理提交。移动端仍不提供交接入口。

## 入口与页面

- 入口：任一 Bot 的侧栏“Advanced／高级”新增“Experience／经验”分区，含“Export experience／导出经验”“Import experience／导入经验”两个按钮。通用及交易 Bot 均可使用。点击后关闭侧栏并在主区域打开整页（`?workspace=experience-export|experience-import`），隐藏聊天输入框；“Back／返回”回到聊天。
- 页面包在现有 `SpaceRpcProvider` 中，所有调用绑定该 Bot 所在工作区：导出时为源区，导入时为目标区，符合契约对 `catalog/create` 与 `preview/confirm` 的工作区要求。

**导出（源 Bot）**

- 选择内容：`catalog` 返回的记忆／Skill 逐项勾选，按后端 `sourceType` 标明来源：“This Bot's memory／本 Bot 记忆”“Shared memory／共享记忆”“Workspace Skill／工作区技能”“Imported Skill／导入的技能”；复选框可访问名称为“来源＋标题”，同名的 Bot 记忆与共享记忆在勾选前即可区分。可另加用户确认的总结（标题＋正文）；不自动导出聊天。
- 适用条件至少一条，已知局限可选；标题、条件和至少一项内容齐备才可创建。
- 已有交接包时可选“新交接包”或“某包 vN 的下一版本”（只列每条版本链的最新版）。
- 创建经现有身份确认；`requestId` 每个待创建的包固定一份，重试复用，成功后换新。创建后表单清空，新包在列表中展开。
- 交接包列表：标题、版本、时间、撤销状态；展开为固定快照：来源 Bot／工作区／类型、版本与内容哈希、适用条件、已知局限、每项内容（类型、标题、来源版本、正文）。未撤销的包可“撤销”（身份确认）。
- 交接历史：本 Bot 作为来源的导入回执。

**导入（目标 Bot）**

- 选择交接包：`packages` 列出当前用户有权的交接包（可跨业务），已撤销的不列出。
- 选择后立即 `preview`（不写入）：显示来源、版本哈希、适用条件、已知局限和各项内容；每项给出“复制／跳过”与目标名称，冲突项在该行显示原因并标记输入无效。
- 修改方案后必须“重新预览”；有冲突、方案未重新预览或已导入时“导入”不可用。确认被 `STALE_PREVIEW` 拒绝时，保留当前方案、禁用导入，并立即可“重新预览”，无需修改方案或重选交接包；重新预览沿用当前方案，冲突检查与确认机制不变。确认时原样提交预览返回的 `plan` 与 `previewHash`，经身份确认。没有覆盖选项。
- `alreadyImported` 非空时显示“已导入到此 Bot”及原回执，不再提供导入。
- 结果分区：
  - “Imported experience／已导入经验”：回执中已复制的总结和记忆（目标名称与来源版本），导入即作为记忆可用。
  - “Imported Skills／导入的技能”：交接 Skill 副本，状态为“待启用”“已启用”或“已暂停：共享技能占用了同名”；开关调用 `updateSkill`（带 `expectedRevision`，身份确认）。
  - “Handoff history／交接历史”：本 Bot 作为目标的回执；展开时按需读取 `importDetail`，显示导入当时的包快照（来源、哈希、适用条件、局限），不依赖当前源区访问权。

**错误**：页面保存失败本身（原因代码或原始错误）而非文字，渲染时按当前语言生成文案，切换语言后已显示的提示立即更新。按 `data.reason` 显示界面语言文案：`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`SOURCE_CHANGED`、`STALE_PREVIEW`、`PACKAGE_REVOKED`、`MEMORY_PROVIDER_UNSUPPORTED`、`INVALID_INPUT`；预览冲突 `TARGET_EXISTS`、`DUPLICATE_TARGET`、`BUILTIN_SKILL_NAME`。未知代码显示通用“无法继续”；失败不显示为完成。目录或包列表加载失败也在同一处提示。

## 改动文件

- `apps/web/src/pages/ExperienceHandoff.tsx`（新增）：导出／导入页面、包快照、回执、历史及错误文案。
- `apps/web/src/pages/ExperienceHandoff.test.tsx`（新增）：10 项 jsdom 单元回归。
- `apps/web/e2e/experience-handoff.spec.ts`（新增）：1 项浏览器回归。
- `apps/web/src/pages/shell/bot-panel.tsx`：可选 `onOpenExperience`，提供时显示“经验”分区。
- `apps/web/src/pages/shell/side-panel.tsx`：关闭侧栏并导航到交接页。
- `apps/web/src/pages/Shell.tsx`：懒加载页面、读取 `experience-export|import`、交接页时隐藏聊天输入框。
- `apps/web/src/locales/*/messages.po`：新增 45 条文案并补来源注释，填写 `en`、`zh-CN`、`zh-TW`，其他语言留空回退英文；与提取前快照对比只有新增，无删除或改写。

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @rakazo/web check` | 通过 |
| `pnpm --filter @rakazo/web test` | 184 文件、1741 项通过（含本页 10 项） |
| `biome check` 六个改动源码／测试文件 | 通过 |
| `API_PORT=3210 WEB_PORT=5280 LOCAL_AUTO_LOGIN_EMAIL='' NODE_ENV=test pnpm test:e2e --spec=experience-handoff` | 1 项通过（隔离测试库，含新迁移） |
| 同上，`--spec=business-cycle-drafts`、`'--spec=business-cycle\.spec'` | 4 项、1 项通过，确认 Shell 改动未影响业务周期页 |

单元回归另覆盖：同名 Bot 记忆与共享记忆按来源区分且勾选后发送对应 ID；`STALE_PREVIEW` 后方案保留、导入禁用、可立即重新预览并以新哈希确认；切换语言后已显示的错误立即改为当前语言。

单元回归覆盖：创建请求的 ID／版本、总结与适用条件精确发送，创建后展开固定快照；`SOURCE_CHANGED` 中文化提示且保留表单；下一版本选项与撤销；预览冲突→改名使方案失效→重新预览→按原 `plan`／`previewHash` 确认；已导入记忆与待启用 Skill 分区；已导入时不再提供导入；已撤销包不列出；启用 Skill 携带 `expectedRevision`；历史展开才读取 `importDetail` 并显示快照。

浏览器回归（真实 API 与数据库）：在业务 A 的现货 Bot 中经侧栏打开导出，两个 `MEMORY.md` 分别显示为本 Bot 记忆与共享记忆，勾选工作区 Skill、填写条件／局限／总结并创建 v1，快照显示来源、条件、局限和 Skill；在业务 B 预先建立同名 Skill，经目标 Bot 侧栏打开导入，页面不显示聊天输入框；预览显示业务 A 来源与条件；默认目标名称以 `handoff-` 开头，改回 `deviation-review` 后重新预览出现“此 Bot 已有同名内容”且不可导入；改为 `deviation-review-imported` 重新预览后，在页面外于目标区建立同名 Skill，再点导入得到真实 `STALE_PREVIEW`：提示显示、方案仍为该名称、导入禁用、“重新预览”可用；切中文提示变为“目标已变化，请重新预览后再导入”，切回英文恢复；重新预览出现新冲突，改为 `deviation-review-handoff` 后导入；回执显示待启用，已导入经验只含总结副本，导入的技能显示待启用，开启后显示已启用；历史显示“业务 A Bot → 业务 B Bot · v1”，展开后显示导入时的适用条件；中文 390px 无横向溢出，侧栏已关闭。

截图（合成数据，已查看）：`apps/web/test-results/experience-handoff/` 下 `experience-export-en.png`、`experience-import-conflict-en.png`、`experience-import-done-en.png`、`experience-import-narrow-zh.png`、`experience-import-stale-zh.png`（过期预览的中文提示）。Playwright 每次运行会清空 `test-results/`，截图在全部运行结束后放回。

## 需要后端确认

1. 已解决：后端为 `catalog` 增加 `sourceType`，前端已接入。
2. 默认目标名称为 `handoff/<包 ID>/<序号>.md` 与 `handoff-<包 ID 前 8 位>-<序号>`，可读性差；用户可在方案中改名。若希望默认沿用原名（冲突时再改），需后端调整默认方案。

## 未验证与边界

- `STALE_PREVIEW` 的拒绝、保留方案、重新预览恢复已通过隔离浏览器回归；修复前的实际浏览器报告另有包撤销、源 Bot 归档和删除后读取历史的证据。源工作区成员权限撤销与非空模拟凭据/交易授权不转移，通过的是后端隔离 RPC/PostgreSQL 测试。
- 完全相同 confirm 的串行、并发和失败重试通过的是隔离进程内 RPC 测试；**浏览器 HTTP 重放、并发及响应丢失后的重试仍未验证**。重复选包不显示导入按钮不能替代请求级验收。
- 交接 Skill 正文编辑已在 07 提供（见下节）；目标记忆沿用现有记忆编辑入口。
- 交易 Bot 打开交接页时顶部 Bot 工作区导航仍高亮“聊天”。
- 未运行 Electron E2E、移动端或全仓 CI；后续实际浏览器报告记录两次真实模型读取导入 Skill，但模型质量提升和业务收益没有验证。

## 07：导入 Skill 正文编辑

在导入页“Imported Skills／导入的技能”每个副本旁增加“Edit／编辑”，编辑目标 Bot 自己的副本（完整 SKILL.md）。复用现有 `updateSkill`、`expectedRevision` 修订检查、身份确认与启停开关，没有新增接口或另建记忆管理（导入的记忆仍用现有记忆编辑入口）。

- 打开编辑时记录当时的修订号作为依据；保存只发送 `skillId`、`expectedRevision`、`content`，不发送 `enabled`，编辑不改变启用状态，也不授予任何权限。
- 保存前用共享 `parseSkillMd` 预检：缺少名称／说明的开头信息时提示“SKILL.md 需要包含名称和说明的开头信息”；名称被改时提示“请保留名称 {名称}”（后端不允许导入后改名）。两者都不发请求，草稿保留，输入框标为无效。
- 后端对修订冲突与“启用中的副本与其他 Skill 同名”都返回 `CONFLICT`。前端收到后重新读取副本：修订号已变即判定为他处先保存，显示“此技能已在别处被修改，你的草稿已保留”、可展开“最新版本”，并提供“使用最新版本”（以最新正文替换草稿）或“保留我的草稿”（以最新修订为依据，再次点击保存才写入）；处理前保存按钮禁用，不会覆盖较新内容。修订号未变则提示“另一个技能已使用此名称。停用此副本后才能保存”。
- 编辑中仍可用开关启停。只有当草稿依据仍等于当前修订（即期间没有他处修改）时，本行开关成功后才把依据推进到新修订，避免自己的启停让草稿过期，同时不会跳过他处较新的正文。
- 其他失败（不存在、权限等）在该副本内按原因显示当前界面语言文案，草稿保留，切换语言即时更新。
- 新增文案 8 条（填写 `en`、`zh-CN`、`zh-TW`），与提取前快照对比只有新增。

### 验证（隔离测试环境）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @rakazo/web check` | 通过 |
| `pnpm --filter @rakazo/web test` | 184 文件、1748 项通过；`ExperienceHandoff.test.tsx` 18 项（07 新增 7 项） |
| `biome check` 改动文件 | 通过 |
| `API_PORT=3310 WEB_PORT=5380 LOCAL_AUTO_LOGIN_EMAIL='' NODE_ENV=test pnpm test:e2e --spec=experience-handoff` | 1 项通过（真实 API 与隔离数据库） |
| `API_PORT=3317 WEB_PORT=5387 pnpm test:integration --spec=experience-handoff` | 24 项通过；浏览器回归结束后单独运行 |

单元回归：按读取时修订保存且不含 `enabled`、保存后再次打开为新正文；无效 SKILL.md 与改名在发送前拦截；他处先保存时草稿保留、显示最新版本、保存禁用，选择保留草稿后以新修订保存；选择使用最新版本时替换草稿；同名冲突时草稿保留，本行停用后以新修订保存；其他失败显示原因且随语言切换。

浏览器回归：导入并启用 Skill 后编辑正文并保存，仍为已启用，`skills` 返回新正文；`get` 读取的固定版本包仍为源正文；再次编辑时由另一请求先保存，点保存后显示冲突、最新版本为他处内容、草稿不变、服务端仍为他处内容；中文 390px 冲突提示正确且无横向溢出；选择保留我的草稿后保存成功并仍为启用；`importDetail` 中导入时快照不含任何后续编辑。截图：`experience-skill-conflict-narrow-zh.png`、`experience-skill-edited-en.png`（运行目录 `apps/web/test-results/`，Playwright 下次运行会清空）。

运行时读取由后端集成测试覆盖：“activates a Skill only for the selected Bot and allows independent, version-checked edits”验证编辑后已启用副本被目标 Bot 目录读取为新正文、其他 Bot 不可读、修订过期被拒、包快照不变、停用后不可读；“reports builtin and shared Skill conflicts…”覆盖同名冲突时不加载副本。

### 缺陷修复：Keep my draft 后残留旧冲突提示

Desktop 续验 `pfa-r1-5gXq2pU1` 07-C：冲突后点“Keep my draft”，草稿保留、保存可用，但仍显示 `This changed meanwhile. Reload and try again`。原因：保存被 `CONFLICT` 拒绝时，通用操作状态记下了该失败；冲突面板显示期间被遮住，“保留我的草稿”／“使用最新版本”只清除了行内冲突状态，没有清除这条已处理的失败，面板关闭后旧提示重新出现。

修复：操作状态提供 `clear()`，仅在用户以“保留我的草稿”或“使用最新版本”处理冲突时调用；修订依据、草稿与其他未处理的错误不受影响，下一次操作照常重新判断。新增定向回归“冲突 → 保留我的草稿 → 旧提示消失 → 期间又出现更新修订时以旧依据保存被拒、草稿保留 → 再次保留 → 以最新修订保存成功”，并在“使用最新版本”用例中断言旧提示消失。去掉修复后这两个用例失败，恢复后通过。浏览器回归在“保留我的草稿”后断言该副本内无提示且草稿仍在，随后保存成功。

### 中文窄屏验证（隔离 Playwright）

`experience-handoff.spec.ts` 中冲突出现后切换中文并设为 390×844，在页面内实测 `innerWidth=390`、`documentElement.clientWidth=390`、`scrollWidth=390`、`devicePixelRatio=1`（作为测试附件 `narrow-viewport` 记录并断言）。随后全程在中文 390px 完成编辑：编辑框可访问名称为“deviation-review-handoff 的 SKILL.md”，左右边界均在视口内且页面无横向滚动；点“保留我的草稿”后该副本内无提示、草稿不变；在窄屏追加一行“窄屏补充：先核对计量更正。”后点“保存”，编辑框关闭、仍为“已启用”、无提示；`skills` 返回的正文同时含原草稿与窄屏补充；重新“编辑”可读到该正文后“取消”。导入时快照不含任何后续编辑（含窄屏补充）。命令：`API_PORT=3310 WEB_PORT=5380 LOCAL_AUTO_LOGIN_EMAIL='' NODE_ENV=test pnpm test:e2e --spec=experience-handoff`，1 项通过。

截图与实测值保留在 `.scratch/etraderbot-foundation/evidence/07-narrow-zh/`：`experience-skill-conflict-narrow-zh.png`（冲突与最新版本）、`experience-skill-kept-narrow-zh.png`（保留草稿并补充后、保存前）、`experience-skill-saved-narrow-zh.png`（保存后）、`viewport.json`。

### 交给 Codex CLI 的接口缺口（非阻塞）

`updateSkill` 的两类拒绝复用同一原因，前端需额外读取才能区分：修订冲突与启用副本同名冲突都为 `CONFLICT`；SKILL.md 无效与改名都为 `INVALID_INPUT`。建议提供区分的 `data.reason`（例如 `STALE_REVISION`、`NAME_UNAVAILABLE`、`INVALID_SKILL_MD`、`NAME_LOCKED`），保留现有 HTTP 状态与 `message`。前端现有处理在后端调整后可直接改为按原因判断。

### 未验证

- 未在浏览器中让模型真实调用 `skill_read` 读取编辑后的副本，运行时读取以后端集成测试为准。
- 同名冲突与“使用最新版本”路径只由单元测试覆盖；中文 390px 的编辑与保留草稿已在隔离 Playwright 验证（见上节），真实设备与 Electron 未验证。
- 未使用共享开发启动流程（等待 01）；未运行 Electron E2E、移动端或全仓 CI。
