# eTraderBot 理想关系图（已确认）

> 2026-11-03。交易员通过壳与各独立交易 Agent 沟通；算法库独立；跟人学 + 复盘/人审后启用。

\\mermaid
flowchart LR
  T[交易员] --> Shell[eTraderBot 壳]
  Shell --> ML[中长期 Agent]
  Shell --> SP[现货 Agent]
  Shell --> RK[风控 Agent]
  Shell --> RV[复盘 Agent]

  ML & SP & RK & RV --> Perm[各自接口权限]
  Perm --> Data[公司数据 / 执行适配器]
  ML & SP -.->|跟人学| Exp[经验 / 技能]
  RV -->|复盘过线| Algo[独立策略算法库]
  Exp --> Algo
  ML & SP -->|调用版本| Algo
  Algo -->|结构化量价| ML & SP
  RK --> Gate[门禁 · 影子 / 人审]
  ML & SP --> Gate
  Gate -->|令牌后| Data
\
要点：交易员只跟壳和各 Bot 聊；算法独立版本化；学经验不直接改 live，过复盘和人审才启用。
