# V1.1 第一批：交易与通用工作区隔离

2026-11-04。实现 [ADR 0004](../adr/0004-trading-general-workspace-isolation.md) 的首批运行时隔离。继续使用现有 Space、Bot、Run、加密存储、RPC 和工具执行器。[ADR 0005](../adr/0005-versioned-experience-handoff.md) 的固定版本经验交接留到下一批。

## 工作区与 Bot

- `Space.kind` 为 `trading` 或 `general`。四种交易模板只能创建于交易区，普通 Bot 只能创建于通用区。角色不能原地修改。
- Bot 创建、复制及导入经过后端检查；数据库触发器再次检查归属与电脑。导入普通 Agent 只允许通用区。复制保留模板角色，但不复制逐笔批准、范围授权或资料读取授权。
- 交易配置、场景和分析只能写入有效交易区。交易工具校验持久化 Bot 的角色、工作区、成员关系和场景绑定，人工批准依然独立。
- Web/Electron 共用的工作区选择器显示类型，创建界面按类型显示模板。“全部 Bots”保留，打开 Bot 后切换 RPC、聊天及资料上下文。移动端提供类型及模板选择；交易业务字段与资料授权管理在 Web 配置。

## 资源入口

- 每次运行开始及工具调度重新核对 Bot 身份和电脑归属；工作区待迁移时拒绝运行。电脑必须属于同一 Space 和使用者。
- 普通 Bot 禁用宿主电脑及 `user_computer_*` 工具，避免宿主目录、浏览器会话成为共享通道。通用区须使用独立沙箱电脑。
- 共享记忆、历史和文件使用当前 Run 的 Space。Skill、MCP 和 HTTP 工具安装的 `allSpaces` / `availableIn` 不跨交易边界生效；应用查询和数据库 RLS 均检查。普通 Bot 不能调用宿主 stdio MCP；远程 HTTP/SSE MCP 仍支持。
- 跨区 Bot 消息只允许通用区之间按原有开关通信，不能借交易 Bot 间接执行。交易区之间也不靠这个开关共享资源。
- Bot 凭据库固定到工作区；历史账号凭据保留，停止隐式供 Bot 继承。账号级模型连接不受此改动影响。
- 外部语义记忆的共享命名空间不能跨区复用。现有自定义命名空间若不等于当前工作区的隔离命名空间，运行时明确拒绝；没有自动搬运或删除远端历史资料。

隔离边界覆盖应用管理的资源与凭据。外部 HTTP/MCP 服务自身的账户权限仍由该服务实施；本批没有真实公司接口可用于端到端权限联调。

## 最小只读授权

授权人是源交易工作区所有者，接收者是同一使用者拥有、位于通用区的指定普通 Bot。资料范围精确到一条分析、天气批次、记忆文档或 Skill；没有文件目录、凭据、接口配置或交易权限的批量授权。

- 默认不可见。所有者在接口设置中的“资料只读授权”选择 Bot 和资料。
- `workspaceAccess` RPC 与 `read_trading_material` 工具共用服务；工具只支持列出授权和按授权 ID 读取。每次重查接收 Bot、当前归属、源成员资格及撤销状态。
- 返回选定资料的内容与修订标识，限制为 256 KiB；不授予源工作区上下文、工具或写权限。授权对象是该记录，读取当前内容，并非固定版本交接包。
- 授权、读取、拒绝读取和撤销追加审计，不记录资料正文。读取与撤销通过授权行锁协调；撤销后后续读取拒绝，已经交付的文字无法收回。重新授权产生新 ID。
- 复制/导入不会复制授权；跨使用者交付、固定版本包、文件类授权及订阅同步没有在本批实现。

## 迁移

新增迁移 `20261126120000_workspace_isolation` 和 `20261126130000_workspace_install_rls`，保留既有字段及记录 ID。DDL 识别已有交易配置、场景、分析和模板；混有普通 Bot 的交易区标记 `isolationPending`，不自动搬运资料。

离线迁移命令默认只预检，需要显式给出目标数据库和归属计划：

```sh
pnpm exec tsx apps/api/src/cli/workspace-isolation.ts --plan=/path/to/reviewed-plan.json
pnpm exec tsx apps/api/src/cli/workspace-isolation.ts --plan=/path/to/reviewed-plan.json --apply --fingerprint=<preflight-hash>
```

运行前设置 `DATABASE_URL` 及原加密密钥配置；不要把配置或计划中的真实账户标识提交到仓库。执行前停止 API/worker，备份并先验证隔离数据库副本。计划格式：

```json
{
  "sourceSpaceId": "synthetic-source",
  "userId": "synthetic-owner",
  "botIds": ["synthetic-general-bot"],
  "targetSpaceId": "synthetic-new-general-space",
  "targetName": "General workspace"
}
```

预检列出数量、阻断项和指纹；应用时加锁重新计算，资料变化即拒绝。共享群、跨会话引用、旧交易绑定、附件/文件、专属电脑历史、Skill/暂存资料、凭据、外部投递或活动运行等不明确情况停止迁移，需另行确认归属，不能猜测。

本次使用者明确选择：普通 Bot 及其专属聊天、记忆进入新通用区，共享记忆和电脑文件留在原交易区。迁移保留消息/事件/运行/记忆修订的 ID 和引用，重新加密内容及消息搜索索引，分配空白独立电脑。迁移到新工作区的定时任务暂停，待配置复核；原交易学习计划不改变。

本地数据库副本验证通过后才迁移原库：1 个 Bot、1 段聊天、7 条消息、33 条事件、1 份专属记忆及 3 次历史运行保留。解密后内容摘要一致；20 张交易相关表共 23 条记录的完整行指纹一致；1 份共享记忆和 1 台原电脑不变。备份与详细校验记录保存在本机临时目录，没有写入仓库。

## 验证与边界

验证命令及最新统计见 [实施记录](eTraderBot-v1-progress.md) 与 [验收记录](eTraderBot-v1-acceptance.md)。数据库测试覆盖原始 SQL/RLS、后端创建、伪造运行上下文、交易与文件工具、MCP 调用、共享记忆、资料授权和加密迁移；浏览器覆盖两类工作区、模板、复制授权不继承、资料授权/撤销、中英文和窄屏、全部 Bots 上下文及原交易流程。

尚未执行原生 iOS/Android 设备、Electron E2E、真实模型语义/费用/效果或真实公司接口验证。外部自定义命名空间的历史归属保留待审；未进行远端数据迁移。独立强化学习、论文算法复现和实盘继续暂缓。

合成数据界面截图：[英文资料授权](../demo/etraderbot-workspace-isolation-en.png)、[中文窄屏](../demo/etraderbot-workspace-isolation-narrow-zh.png)。
