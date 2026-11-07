# eTraderBot 已完成 · 待办

一页速览。**原 v1 计划**与**后加项**分栏，避免混在一起。细节见各计划／`docs/implementation/eTraderBot-v1-progress.md`。\
整理：2026-11-07（基座加固 01–09 收尾）

**最新阶段：01–09 全部 done。** 完成范围、证据入口和保留限制见[基座阶段验收汇总](../implementation/eTraderBot-foundation-acceptance.md)。本次只更新记录；后续事项尚未启动。

图例：`done` · `wip` · `todo` · `later` · `blocked`

---

## A. 原 v1 计划（实施计划／progress 批 1–6）

### A1 总览

| 域 | 状态 | 一句话 |
|---|---|---|
| Demo 概览页（PPT 翻页 HTML） | done | 壳原理／关系图；用户自刷 |
| 契约＋合成基线＋模拟交易 RPC | done | 批 1 |
| 批准／范围授权／模拟执行＋审计 | done | 批 2 |
| Bot 工具＋Web／移动交易入口 | done | 批 3 |
| 每日／手动学习＋参数候选 | done | 批 4；仅固定算法参数 |
| 四角色 Bot 模板＋工作区内嵌 | done | 批 5 |
| 业务范围工作区＋接口**配置** | done | 批 6；后续天气接入及只读 MCP 样例另有验收，公司交易接口仍待联调 |
| 真实数据／真报盘联调 | later | 等外部适配与字段映射 |
| 论文级算法／多改进案例 | todo | 现为工程基线＋参数候选 |
| 壳大改／第二套编排替代 rakazo | — | **不做**（已否决） |

### A2 已完成

| 项 | 备注 | 出处 |
|---|---|---|
| 多 Agent 壳接线口径（只接线不大改） | 花名册／会话／Skill／Routine／互派 | 09 / demo |
| Demo：`eTraderBot-overview.html` | 类 PPT；无 rakazo 名 | `docs/demo/` |
| 统一交易契约＋OpenAPI | Zod → OpenAPI 3.1 | 批 1 |
| 售电／发电／储能确定性计算基线 | 合成；非论文复现 | 批 1 |
| `trading.simulate/get/history/replay` | 壳内认证 RPC | 批 1 |
| 算法／交易分权批准＋模拟成交＋幂等 | 额度事务；依据不可改写 | 批 2 |
| `trading` Bot 工具＋角色绑定 | 身份来自 Run | 批 3 |
| Web／移动交易与批准入口 | 复杂配置以 Web 为主 | 批 3–5 |
| 学习 Routine＋四类资料＋参数候选版本 | 启用人审 | 批 4 |
| 中长期／现货／风控／复盘模板 | 工作区切聊天／交易／学习 | 批 5 |
| 业务范围选择器＋HTTP／MCP **配置 UI** | 「已配置 · 未验证连通」 | 批 6 |

### A3 原计划内未完／想做

| 优先级 | 项 | 状态 | 备注 |
|---|---|---|---|
| P1 | 外部 HTTP 读数适配＋字段映射＋连通验证 | later | 批 6 配置之后 |
| P1 | 真报盘／回执适配器联调 | later | 模拟 ≠ 实盘 |
| P2 | 学习：论文复现／非参数产物／真实改进三案例 | todo | 批 4 缺口；算法方向另见 B「agentic RL」 |
| P2 | PDF／Excel 解析进学习资料 | todo | |
| P2 | 跨使用者经验共享（明确选择） | todo | 有设计，能力待补 |
| P2 | Electron／原生全量验收；iOS 截图本机跑 | todo | |
| P3 | 申报回执六状态是否产品化 | todo | 09 待补充 |
| P3 | 公司接口目录、字段字典、限额规则来源 | blocked | 等人／内部资料 |
| — | 对话无限累加上下文 | — | **不做** |
| — | 检索／聊天直接改 live 限额或规则 | — | **不做** |

---

## B. 后加项（原计划外 · 讨论后补进）

> 与 v1 主交付分开跟踪。长文：`eTraderBot-knowledge-layer-plan.md`。

工作区隔离决议见 [ADR 0004](../adr/0004-trading-general-workspace-isolation.md)，目标关系见[架构图](../architecture/eTraderBot-ideal-relation.md)。V1.1 首批隔离及最小只读授权已实施，范围与验证见[实施说明](../implementation/eTraderBot-v1.1-workspace-isolation.md)；固定版本经验交接 MVP 已完成，范围见 B1。业务 Hook 插件框架仅保存设计，暂不启动，见 B3。

### B0 已定口径（后加）

| 日期 | 决议 |
|---|---|
| 2026-11-03 | 经验沉淀：记忆／文档／Skill；交易决策数字：只调用已训练并批准的算法版本（agentic RL 在版本侧，不新挂智能体） |
| 2026-11-04 | 先采用独立通用工作区：普通 Bot 与四类交易模板分开归属，按明确授权只读指定交易资料；细则见 ADR 0004，首批实现见 B1 |
| 2026-11-04 | 经验交接固定版本导入，目标 Bot 独立积累，不自动跟随源修改或继承交易权限；见 [ADR 0005](../adr/0005-versioned-experience-handoff.md)，MVP 完成范围见 B1 |
| 2026-11-06 | 平台级业务 Hook 插件框架：平台维护、随应用发布，支持强制检查和受控后续动作；首例为合成数据源证据补查。仅保存 [Spec](../specs/eTraderBot-business-hooks-spec.md)，使用者明确暂不启动实施 |

### B1 已完成（后加）

| 项 | 备注 | 出处 |
|---|---|---|
| 知识层计划文档 | 选型未定；账本／Registry／RAG／Ontology 边界已写 | `eTraderBot-knowledge-layer-plan.md` |
| 本速览页（done-todo） | 原计划 / 后加分列 | 本文件 |
| 交易／通用工作区隔离及最小只读授权 | 后端、工具、迁移和多端入口已实现；原生设备与真实模型／接口未验收 | [V1.1 实施说明](../implementation/eTraderBot-v1.1-workspace-isolation.md) |
| 每条业务线的主管 Bot | 固定协调身份、任务分配、结果与进度；09 真实模型自主派单已补验，模型质量评价仍未完成 | [主管说明](../implementation/eTraderBot-business-supervisor.md)、[阶段汇总](../implementation/eTraderBot-foundation-acceptance.md) |
| 模拟业务周期与证据依赖协作 | P25 主流程及缺陷定向验收通过；09 补真实模型协作、负责人接续和中断恢复；质量、收益及正式账单接入未验收 | [业务周期说明](../implementation/eTraderBot-business-cycle.md)、[阶段汇总](../implementation/eTraderBot-foundation-acceptance.md) |
| 固定版本经验交接包与独立导入 MVP | 同一用户跨业务导入、来源区分、冲突与过期预览恢复、Skill 人工启用及历史保留已验收；权限与重试幂等有隔离 RPC/PostgreSQL 测试，浏览器 HTTP 重试及移动/原生端仍未验收 | [后端与收尾记录](../implementation/eTraderBot-experience-handoff.md)、[前端记录](../implementation/eTraderBot-experience-handoff-frontend.md) |
| 基座加固 01–09 | 九票按原范围 done；含导入 Skill 独立编辑、真实模型连续演练和只读 MCP 样例。精确去重与部分权限拒绝采用确定性自动化证据 | [阶段验收汇总](../implementation/eTraderBot-foundation-acceptance.md) |

### B2 待办／想做（后加）

| 优先级 | 项 | 状态 | 备注 |
|---|---|---|---|
| P1 | 既有测试失败与完整 CI 基线 | todo | authorization 4 项、executor-turn-checkpoint 27 项失败及较早 testkit／Expo／bot-secrets 检查限制仍保留；单独复现处理，不把历史定向通过当全量 CI |
| P1 | Graphile 多进程恢复验证 | todo | 当前真实进程恢复使用 memory 唤醒驱动；生产默认多进程投递与恢复另验 |
| P2 | 真实模型缓存工具撤权后的实际 refused | todo | 工具不可见、跨业务 RPC 404 与隔离执行器 refused 已分别记录，真实模型对应调用证据尚缺 |
| P2 | 侧栏“文档”入口指向内部资料 | todo | 目标待确认：平台内文档页、本项目 GitHub 目录或既有文档站；尚未修改页面 |
| P2 | 经验交接的 HTTP 请求级重试验收 | todo | 相同 confirm 的浏览器重放、并发与响应丢失后重试；隔离 RPC 通过不能替代这一项。跨使用者共享及原生端验收仍见 A3 |
| — | 通用业务 Hook 插件框架与证据补查首例 | later | [Spec 已保存](../specs/eTraderBot-business-hooks-spec.md)，暂不启动；拆分见 B3，不计入当前已交付能力 |
| P0 | 拍板知识层：RAG / Ontology / 并行；内置 vs MCP | todo | K0；填 knowledge-layer §8 |
| P0 | `RuleRegistry` 最小契约（可空配置） | todo | K2；执行不认 RAG 片段 |
| P1 | 说明文档检索 MVP（若选 RAG） | todo | K3；无放行效力 |
| P1 | Ontology 只读查询（若选／并行） | todo | K4；对齐储能本体 demo |
| P2 | 语料边界清单（进知识层 vs 进账本） | todo | K1 |
| P2 | Bot 检索工具白名单（按角色） | todo | K5 |
| P1 | 交易决策算法：**agentic RL 只产出可调用算法版本** | todo | **已定**：跟学／记忆／文档／Skill 管流程与像人协作；决策数字只调已 RL／已批准的 AlgoRunner 版本；不新增 Agent；离线训、现场不训；复盘人审后升版 |
| — | 用知识库替代业务账本 | — | **不做** |

### B3 业务 Hook 插件框架（暂缓实施）

设计见 [业务 Hook 插件框架 Spec](../specs/eTraderBot-business-hooks-spec.md)。以下为后续任务拆分，全部保持 `later`；保存设计不表示开始开发。

| 编号 | 任务 | 状态 | 完成边界 |
|---|---|---|---|
| H0 | 细化插件契约、能力声明与规则组合 | later | 复用现有门禁与业务服务；明确身份、版本、原因码、强制拒绝优先级及预算 |
| H1 | 内部插件注册、执行管线与 runtime 接入 | later | 平台代码随应用发布；同步检查、结果观察和受控变换可组合，业务规则保持共享 |
| H2 | 后续动作持久化与通道权限约束 | later | 复用 Task/Run，支持幂等、取消、恢复及递归限制；交易写入统一受控，单个 Bot 只能收紧业务配置 |
| H3 | 受限可信采集入口与合成数据源 | later | 明确采集能力授权；服务实际取数，校验业务/周期/来源/版本；保留现有人工导入边界 |
| H4 | 证据补查插件与原 Bot 恢复 | later | 区分缺证据、缺前序任务和缺批准；可信数据校验入库，其余人工确认；恢复分析并生成新请求 |
| H5 | 确定性、集成及适用界面验收 | later | 覆盖 Spec H01–H12；真实模型、真实接口和原生端的验证边界分别记录 |

---

## 近期建议顺序（可改）

基座加固已经完成；先按 B2 单独安排基线失败及剩余验证，再确定一个具体业务的真实只读数据源接入。这里记录后续方向，不自动启动新任务。

**原计划线：** 外读适配 → 连通验证 → 真报盘联调；学习论文／案例按节奏插。\
**后加线：** K0 选型 → K2 Registry 契约 →（可选）K3／K4。

**已记录的后续方向：** 业务 Hook 插件框架暂不排入当前开发；明确启动后按 B3 的 H0–H5 推进。

---

## 维护约定

- 原 v1 范围 → 只改 **A**；讨论后新开的能力 → 只改 **B**。\
- 做完改 `done`；新想法先丢进对应区，不写长文。

*不构成合规认定；不授权未审批实盘。*


### 天气数据接入增补（2026-11-04）

`done`：业务范围内天气 HTTP 主动拉取、外部令牌推送、校验与不可变存储、绑定 Bot 查询、中英界面，以及公司内部天气模型接口模拟服务。详见[天气接入](../integration/eTraderBot-weather-api.md)和[实施记录](../implementation/eTraderBot-v1-progress.md)。其余交易接口仍待适配；真实天气推理、天气到出力／负荷映射与效果验证不包含在该完成项内。
