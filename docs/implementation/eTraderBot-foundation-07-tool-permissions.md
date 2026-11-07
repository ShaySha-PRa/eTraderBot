# 07：工具读取与正文编辑权限补测

2026-11-06，工作区 `platform-foundation`，分支 `feat/platform-foundation`，HEAD `de2b7967c2b7353d621b31ffce4ee44bc0fed4c1`。以当前未提交实现为准，接续 Desktop 的工具／权限证据盘点。本次只补测试和记录，未发现实现缺陷，没有修改运行时代码、契约或数据库结构。

## 已补齐的验证

唯一代码改动为 `apps/api/src/experience-handoff.postgres.test.ts`。

1. 编辑并启用导入副本后，以目标 Bot 的 `userId`、`spaceId`、`botId` 在租户上下文调用真实 `skillReadFromTool`。按当前工具契约，省略 `file` 读取主 SKILL.md；`file` 用于附属文件。断言返回完整正文与保存后的副本一致，包含新的目标正文、不包含旧正文，并保留 `readOnly` 与正确导入 ID。
2. 停用副本后，直接调用 `listAgentSkillRecords`，断言不存在该 `handoff:<id>`；保留已有 `skillReadFromTool` 拒绝断言。
3. 已启用副本遇到后来创建的同名共享 Skill 时，直接断言目标 Bot 目录排除该副本；保留已存在的 `name_conflict`、直接读取拒绝及启用冲突断言。
4. 新增 14 个 `updateSkill(content)` 权限用例：以下 7 种情形分别在副本待启用和已启用时测试。请求携带当前有效修订及合法完整正文，不包含 `enabled`，避免无效内容或过期修订抢先拒绝而掩盖权限路径。

| 拒绝条件 | 实际 RPC 错误 code / status |
| --- | --- |
| 会话未完成近期身份确认 | `IDENTITY_CONFIRMATION_REQUIRED` / 403 |
| 同工作区另一位 owner，非副本所属用户 | `NOT_FOUND` / 404 |
| 所属用户切到另一个自己拥有的工作区 | `NOT_FOUND` / 404 |
| 所属用户的目标区成员资格被撤销 | `FORBIDDEN` / 403 |
| 所属用户从目标区 owner 降为 member | `FORBIDDEN` / 403 |
| 目标 Bot 归档 | `FORBIDDEN` / 403 |
| 目标 Bot 的所属用户改为同区另一位 owner | `FORBIDDEN` / 403 |

这里的 owner 要求来自实际经验交接服务的 `transaction → owner` 校验；没有将普通成员一概无权作为其他产品接口的假设。非所属用户用例授予对方实际目标工作区 owner 成员资格，使测试落在副本所有权检查，而非仅验证工作区不可访问。

每例先用合法身份进行一次成功的正文编辑，确认启用时间不变、修订递增。随后改变权限或 Bot 状态，再提交不同的合法正文，断言准确拒绝，并完整比较拒绝前后的副本行、固定包、导入回执和全部该包交接事件。因此正文、修订、启停时间、更新时间和历史均不能悄悄改变。目标区权限失效后用隔离夹具的系统读取核对持久化状态，同时从仍获授权的源区通过 `get`、`importDetail` 验证固定包及历史仍可读取且相同。没有为通过测试恢复权限、删除历史或调整权限规则。

## 实际结果

| 命令 | 结果 |
| --- | --- |
| `API_PORT=3541 WEB_PORT=5611 pnpm test:integration --spec=experience-handoff` | 1 文件、38 项通过，退出码 0；原 24 项加 14 项权限用例，主正文／目录断言补入原用例。 |
| `pnpm exec vitest run packages/adapters/src/skill-tools.test.ts` | 1 文件、11 项通过，退出码 0。 |
| `pnpm --filter @rakazo/api check` | 通过，退出码 0，包含修改后的集成测试文件。 |
| `pnpm exec biome check apps/api/src/experience-handoff.postgres.test.ts` | 通过，未自动修改文件。 |
| `git diff --check` | 通过。 |

复用既有 Testcontainers 集成入口：新建一次性 PostgreSQL 实例及套件专属数据库，加载加密存储、租户隔离和真实业务服务。端口设置 3541/5611，与 Desktop 实例不同；本套件使用进程内 RPC，不启动浏览器或 Web 服务。没有连接 Desktop 验收库或原开发业务库，没有改动其文件、附件、进程及数据。保留 01、03 和 Claude 的 07 改动，未提交、推送或开始 04。

## 证据边界与交接

- 工具证据是直接经过真实 `skillReadFromTool`／`listAgentSkillRecords` 适配器及 PostgreSQL 的目标 Bot 读取；不是完整 Task/Run 分发，也不是真实模型调用或模型使用效果验收。
- 权限证据是隔离进程内 RPC，身份确认状态通过现有认证依赖夹具提供；经过真实路由门禁和业务服务，但不包含浏览器 Cookie、网络身份确认流程或 HTTP 重试。表中 status 是 RPC 错误属性。
- 没有重新执行浏览器、原生设备、Electron、真实模型或全仓 CI。中文窄屏及页面冲突结论沿用各自已有记录，本次不重复计为新通过。
- 过期 `expectedRevision` 继续按现有冲突契约拒绝；没有把正文修改变成幂等重写，也没有新增错误码或更改前端接口。
- 本次关闭指定的两项工具／权限验证缺口。07 的总体验收仍由 Desktop 汇总；03 仍待 Desktop 验收。浏览器请求字段独立抓包、固定包 confirm 的 HTTP 重放等既有边界保留，未扩大本轮范围。
