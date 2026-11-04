# eTraderBot 理想关系图（目标架构）

2026-11-04 更新。复用 Rakazo 承载 Bot 协作，Bot 通过记忆与 Skill 积累业务经验；影响交易决策的算法改进独立版本化，经过验证及人工启用。工作区分离已由使用者确认，具体权限决议见 [ADR 0004](../adr/0004-trading-general-workspace-isolation.md)。下图表示目标关系。工作区隔离首批已实施，范围见 [V1.1 实施说明](../implementation/eTraderBot-v1.1-workspace-isolation.md)；独立算法训练和完整经验交接尚未交付。

## 工作区归属

```mermaid
flowchart TB
  User[使用者] --> Platform[eTraderBot 平台 / Rakazo]
  Platform --> Trading[交易工作区 · 一个业务范围]
  Platform --> General[通用工作区]
  Trading --> Supervisor[业务主管 Bot · 派单 / 汇总 / 进度]
  Supervisor -->|本业务任务| Roles[中长期 / 现货 / 风控 / 复盘 Bot]
  Trading --> Evidence[交易资料、记忆与 Skill]
  General --> Assistants[普通 Bot · 提效及其他非交易任务]
  Assistants --> GeneralResources[通用资料、记忆与 Skill]
  Evidence -.->|明确授权只读| Assistants
```

每条交易业务线固定一位主管，协调任务但不持有交易批准或执行权。

两个工作区并列，通用工作区不包裹交易工作区。地区用于组织具体业务；不同主体、账户或资产的资料与授权仍按业务范围管理。“全部 Bots”只汇总导航，不合并权限。

## 经验交接

默认采用固定版本导入，目标 Bot 随后独立积累，不持续订阅源内容。选择内容、来源与权限的决议见 [ADR 0005](../adr/0005-versioned-experience-handoff.md)，完整交接能力待实施。

```mermaid
flowchart LR
  Source[源 Bot 的记忆、经验与 Skill] --> Selection[选择内容并明确交接授权]
  Selection --> Package[固定版本经验交接包]
  Package --> Import[目标 Bot 导入独立副本]
  Import --> Evolution[在目标业务中验证与继续积累]
```

源 Bot 后续修改不自动影响目标副本；复用新版本需再次明确接纳。交易权限与凭据不随经验交接继承。

## 交易与学习

```mermaid
flowchart TB
  Bots[中长期 / 现货 Bot] -->|调用获准版本| Algo[独立算法版本与运行模块]
  Data[本业务数据与规则快照] --> Algo
  Algo --> Candidate[结构化候选与固定交易意图]
  Candidate --> Gate[后端规则、授权与额度校验]
  Human[人的算法启用批准及交易批准或范围授权] --> Gate
  Risk[风控 Bot] -.->|检查与解释意见| Bots
  Gate --> Execution[执行适配器与回执]
  Execution --> Review[复盘 Bot / 历史证据]
  Review --> Learning[经验与算法改进提案]
  Feedback[授权资料与交易员反馈] --> Learning
  Learning --> Experience[业务经验 / Skill]
  Experience -.->|授权使用| Bots
  Learning -->|算法改进候选| Validation[独立训练与验证]
  Validation --> Approval[人工批准算法启用]
  Approval -->|发布固定版本| Algo
```

经验与 Skill 支持业务协作和经授权的交接；影响交易决策的变化纳入受控算法或规则版本。新算法版本不继承旧交易授权。当前交付仍以合成数据、工程基线、参数候选和模拟执行为主，真实接口、独立强化学习及完整算法插件发布另行实施与验证。
