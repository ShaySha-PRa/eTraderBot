# 固定版本经验交接 MVP：后端实施与验收

日期：2026-11-05。实施基准为 `feat/etraderbot-v1` / `7e2128aa`。
本文保留后端首批及补测证据；本次提交整理同时纳入已完成的
[Web 接入与修复](eTraderBot-experience-handoff-frontend.md)。
`CLAUDE.md` 和无关的业务周期前端修改不纳入本次提交。

## 交付范围

已实现用户主动选择总结、原生记忆、SKILL.md 文本及文本附件后创建固定快照，
并通过预览、冲突处理、确认形成目标 Bot 的独立副本。每包记录源 Bot/工作区、
适用条件、已知局限、格式版本、版本链、来源资料版本与内容哈希。
用户确认的总结文本不被表述为已核验的模型结论，也不自动导出整段聊天。

- 新建请求按用户及 `requestId` 幂等；同一版本至同一目标 Bot 的导入也幂等。
  不同内容/方案复用同一键时冲突；创建后继版本不会改写旧包。
- 预览不写入目标；确认在串行化事务中重查源/目标权限、资料与名称状态。
  全部记忆、首版修订、Skill 副本、回执与审计一起提交。晚期数据库失败全部回滚。
- 名称冲突只允许显式改名或跳过；预览失效必须重新预览，没有覆盖选项。
  同名内置 Skill 也不能覆盖。后续共享 Skill 占用同名时暂停加载交接副本，
  `blockedReason=name_conflict` 明示原因，原副本和历史不被改写。
- 同一用户拥有并管理的业务/通用工作区间可交接。服务端逐次检查工作区所有者、
  Bot 所有者、工作区类型、归档/迁移状态；没有跨用户分享或 Bot 自助跨区导入工具。
- 总结及记忆写入目标 Bot 的原生记忆，可由现有记忆接口独立编辑。
  Skill 保存在目标 Bot 专属表，默认待启用；用户显式启用后进入该 Bot 的目录与
  `skill_read`，同工作区其他 Bot 也不可读取。Skill 编辑/启停仅开放用户 RPC，
  Bot 工具对交接 Skill 只读；目标 Bot 的普通记忆写入仍沿用已有能力。
- 不读取或复制 Secret、连接配置、Bot 模板、角色、算法启用、审批、交易授权、
  额度、运行或计划。SKILL.md 的权限/环境 frontmatter 不继承。
  启用 Skill 是知识可用性操作，不能使主管、风控或复盘 Bot 获得交易写权限。
- 撤销阻止后续导入；已合法导入副本继续独立保留。源区访问丢失后拒绝再次读取源包
  或确认导入，目标仍可查看其导入时快照。删除源/目标 Bot 不级联删除包、回执或
  交接审计；历史按创建时间倒序分页，包含显式跳过项。

接口以 [Claude 接入说明](../integration/eTraderBot-experience-handoff-api.md) 和
[共享契约](../../packages/contracts/src/experience-handoff.ts) 为准。
旧 RPC 返回结构不变；新增 `experienceHandoff` 命名空间。
`importDetail` 返回导入当时的包，`get/packages` 返回源包当前撤销状态，二者不可混淆。

## 文件与适配

| 区域 | 文件 / 改动 |
|---|---|
| 契约 | `packages/contracts/src/experience-handoff.ts`、`index.ts`、`rpc.ts` |
| 持久化 | `packages/db/src/experience-handoff.ts`、导出、Prisma schema、新增迁移 |
| 内容保护 | `row-security.ts`、`content-encryption.ts`、`content-keys.ts`、`content-migration.ts`；四个新模型纳入 RLS 与内容加密/轮换 |
| API | `apps/api/src/routes/experience-handoff.ts` 与路由组合；复用会话和身份确认 |
| 运行时 | `skill-tools.ts`、`executor.ts`、`run-routines.ts`、`task-catalog.ts`、`run-tools-tasks.ts` 传递 Bot 身份并只载入其已启用副本 |
| 回归 | `apps/api/src/experience-handoff.postgres.test.ts`；既有适配器数据库测试替身补空的交接 Skill 目录 |
| 文档 | 接口说明、本记录、ADR 0005、Spec 及实施进度 |

## 迁移与部署影响

迁移 `20261129120000_experience_handoff` 仅新增四张表：
`experience_packages`、`experience_imports`、`experience_skills`、`experience_handoff_events`。
没有旧业务资料搬运、回填、删除或任务状态修改；Bot ID 作为保留的来源标识，
不建立会级联删除历史的 Bot 外键。不可变包/回执由服务层写入规则保护，
内容加密轮换可以重写密文而不改变逻辑内容与哈希。

迁移已在临时 PostgreSQL 上从零应用并验证运行账户 RLS。
后端首批没有迁移开发业务库或触发真实 Run。后续实际浏览器验收已获用户授权，
通过标准迁移命令应用到开发分支库，并核对四表与 RLS；原调查证据和工作记录的
定向指纹保持不变。此次提交整理不再次迁移或改动业务数据。旧版本进程可忽略新增表，
但需要先完成迁移再启用新版运行时。

## 验证结果

以下最终执行均退出 0；数据库回归使用 Testcontainers PostgreSQL 18、
独立测试数据库及非超级用户运行账户。集成端口显式为 API 3417 / Web 5487，
测试输出在 integration 目录，不使用前端 Playwright 目录。

| 命令 | 结果 |
|---|---|
| `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=experience-handoff` | 1 文件，18 项通过 |
| `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=workspace-isolation` | 1 文件，5 项通过 |
| `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=business-cycle` | 2 文件，16 项通过 |
| `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=content-encryption` | 1 文件，14 项通过 |
| `pnpm exec vitest run packages/adapters/src/skill-tools.test.ts packages/adapters/src/task-catalog.test.ts packages/adapters/src/routine-scheduling.test.ts packages/adapters/src/executor packages/core/src/trading` | 27 文件，847 项通过 |
| `pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api check` | 五个包通过 |
| 本批 TypeScript 文件的 `biome check`；`git diff --check` | 通过；未全仓格式化 |

18 项新集成覆盖：固定版本、选择与源版本校验、独立编辑、默认待启用、
同业务其他 Bot 隔离、跨用户/跨区/权限撤销/归档拒绝、身份确认、权限字段注入拒绝、
并发幂等、冲突与过期预览、相同方案响应丢失重试、数据库晚期失败回滚与重试、
版本历史和 Bot 删除、包撤销、导入详情的合法保留、已导入 Skill 再交接、
外部记忆安全拒绝、RLS、密文落盘、内容密钥轮换、名称冲突及分页。
既有业务周期回归保留 P25 23,700 元、更正后重算、审批/角色和任务依赖校验。

首轮验证发现 JSON 快照加密配置需要显式 JSON 标记，已修复；失败注入使用临时库的
迁移账户添加约束，产品请求始终使用运行账户。记录的是最终通过结果。

## 尚未交付或未验证

- Web 选择、预览、导入、历史及三项前端修复已有单元与浏览器证据，详见文末。
  Electron 共用 Web；移动端当前不提供交接入口，不能宣称跨端功能已验收。
- 后端隔离测试没有调用真实模型或接口。后续人工浏览器验收记录了目标 Bot
  两次真实模型读取导入 Skill；没有检验交接经验是否提高模型质量或交易收益。
- 外部记忆提供方没有原子导入协议，本批拒绝相关记忆读写；不导出其本地缓存。
  原生记忆与文本 Skill 可用，纯 Skill 交接不要求原生记忆配置。
- Skill 仅支持持久化 SKILL.md 与受限文本附件；不迁移演示录制、脚本执行环境、
  插件安装或凭据。未做自动脱敏判定；用户选中的正文应先确认适合交接。
- 未运行全仓 CI、Electron E2E、iOS/Android 原生设备；未在开发业务数据上运行回归。
  跨用户分享、持续订阅、自动合并、独立强化学习和实盘接入不在本批范围。

## 2026-11-05 补充：目录来源类型与隔离验收

该次后端补测只修改 `packages/contracts/src/experience-handoff.ts`、
`packages/db/src/experience-handoff.ts`、`apps/api/src/experience-handoff.postgres.test.ts`
和本记录/接口说明。继续在 `feat/etraderbot-v1` / `7e2128aa` 上保留其他会话改动；
没有编辑前端、增加数据库迁移、改写开发库资料、提交或推送。

目录增加必填 `sourceType`：`bot_memory`（本 Bot 记忆）、`shared_memory`
（源工作区内该用户的共享记忆）、`workspace_skill`、`imported_skill`。
这是实时目录元数据，不写进固定包或导入快照。包格式仍为 v1，原有 `kind`、
资料 ID 和版本选择接口不变。接口枚举、旧服务响应缺字段时的降级及旧包边界见
[目录来源类型说明](../integration/eTraderBot-experience-handoff-api.md#目录来源类型2026-11-05-补充)。

先增加同名记忆目录测试，首轮得到 **18 通过、1 失败**：缺失 `sourceType`，
确认了前端不能从相同路径区分来源。仅补目录契约与映射后通过。
权限、凭据/授权和幂等补测未发现业务实现失败，因此未改动这些执行逻辑。

| 分项 | 实际验证与结果 |
|---|---|
| 目录来源 | 同名 Bot/共享记忆分别返回稳定枚举；其他 Bot 专属记忆不入目录；工作区 Skill 和交接 Skill 也有明确类型。通过。 |
| 旧固定包兼容 | 预置没有来源类型的 v1 包、固定的资料/包哈希，源资料 ID 已不存在。目录、包列表、读取、预览、确认、重试及详情正常；源包逻辑内容、密文字节、包/请求哈希和版本保持不变。通过。 |
| 源访问撤销 | 先获得有效预览，再实际删除源区成员资格。源目录/创建及目标读取/预览/原 confirm 被拒绝，包列表不暴露源包；0 收据、0 记忆/修订、0 Skill、0 导入事件。恢复源成员资格后，同一个 confirm 可以成功。已有合法导入副本保留的既有回归也通过。 |
| 凭据与交易授权 | 实际保存加密的模拟工作区凭据和连接令牌；通过业务 RPC 建立已批准模拟算法、意图批准和有效的 Bot 范围授权。导入后源数据未变、仍可取回源凭据；目标没有新增凭据/连接/MCP 或批准/授权记录，包和副本不含模拟密钥、密文或敏感引用 ID。目标执行先因算法未批准而拒绝；测试另行明确批准目标算法后，仍因交易未批准、源授权不匹配而拒绝。通过。 |
| 相同 confirm 串行 | 保存完整请求 JSON（含原 `previewHash`），不重新预览，连续提交 4 次再重试 1 次。5 个响应完全相同；只有 1 收据、2 记忆、2 首版修订、1 待启用 Skill、1 导入事件，0 Task/Run。通过。 |
| 相同 confirm 并发 | 在尚未导入的目标上同时提交同一请求 JSON 4 次，再重试 1 次。响应一致，持久化数量与串行相同。通过。 |

上述权限与幂等结果来自隔离 PostgreSQL 上的进程内 `createRouterClient` RPC 测试，
没有经过浏览器或 HTTP 重试链路。凭据与授权均为合成测试数据，没有调用外部天气、模型或交易服务。
凭据验证使用现有加密存储及读取适配器，交易批准/授权验证使用实际业务 RPC，
不是在空表上仅断言“没有复制”。确认请求不修改 `plan` 或 `previewHash` 来规避幂等检查。

最终验证（均退出 0）：

- `API_PORT=3417 WEB_PORT=5487 pnpm test:integration --spec=experience-handoff`：
  **24 项通过**，原 18 项及新增 6 项；Testcontainers PostgreSQL 18，独立数据库及运行账户。
- `pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/api check`：通过。
- 新增幂等用例后执行 `pnpm --filter @rakazo/api --filter @rakazo/web check`：通过，
  确认现有前端可继续消费扩展后的共享契约；不代表前端已展示来源类型。
- 对本轮三个 TypeScript 文件运行 `biome check`，以及 `git diff --check`：通过。

本轮没有运行浏览器、Electron/原生设备、真实模型或真实接口验收，也未重跑首批的
847 项单测及其他 PostgreSQL 套件；其首批记录保留为历史结果。前端并行实施与
浏览器记录仍由对应会话维护，本轮没有代替其验收或修改它的结果。

## 2026-11-05 提交整理与验收结论

本次汇总共享契约、加密/RLS 存储、RPC、运行时 Skill 适配、Web/Electron 共用页面、
目录来源类型和前端 F1/F2/F3 修复。仅追加目录 `sourceType`；固定包格式仍为 v1，
不改写旧包内容、密文、版本或哈希。四张表的迁移是新增式，没有历史资料回填。

沿用已有执行证据，未重跑整轮浏览器或数据库验收：

- 后端最终 **24 项隔离 RPC/PostgreSQL 测试**通过，涵盖源成员资格撤销、
  非空模拟凭据/批准/授权不转移、相同完整 confirm 的串行及并发幂等。
  串行和并发分别只产生 1 份回执、2 份记忆及修订、1 个待启用 Skill、1 个导入事件。
- Web 单元 **184 文件 / 1741 项**通过（本页 10 项）；交接隔离浏览器场景 **1 项**通过，
  包括来源标签、过期预览恢复及切换语言后的错误更新。
- 修复前的实际浏览器报告验证了正常导入、版本固定、撤销、源 Bot 归档/删除后的历史，
  并记录两次真实模型通过 `skill_read` 读取导入副本。报告内 F1/F2/F3 的后续关闭依据
  为上述修复后的单元与隔离浏览器回归，未声称重新执行了整轮人工验收。
- **浏览器 HTTP 层相同 confirm 的重放、并发和响应丢失后重试仍未验证**；
  页面重复选择显示“已导入”不构成该项通过证据。

实际浏览器原始报告及截图保留在本机忽略的 `test-report/manual-experience-handoff/`，
不将运行消息、业务资料或本机访问地址加入源码提交。总体验收边界同步至
[验收记录](eTraderBot-v1-acceptance.md#固定版本经验交接-mvp-收尾2026-11-05)。

本次提交检查（均退出 0）：

- `pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/web check`：五包通过。
- 暂存范围 35 个 TypeScript 源码/测试文件的 `pnpm exec biome check`：通过，无写入或全仓格式化。
- `git diff --cached --check` 及暂存补丁的 Gitleaks 脱敏扫描：通过。
- 精确暂存经验交接相关文件；6 个无关修改文件逐字节指纹保持不变，没有纳入提交。

这些提交检查不替代先前的隔离 RPC、浏览器或真实模型验证；本次没有新增相关运行。
