# 08：标准只读工具接入样例（CLI 交付）

2026-11-07，`platform-foundation` / `feat/platform-foundation`，开始及交付核对 HEAD 均为 `a6cf2bd9cc8b7cce1fbb438ed1e874337f702c5c`。保留原有修改、04/06 工作及 Desktop 验收现场；未提交、推送、reset、clean 或启动 09。

**后端样例、接入文档及隔离自动化已交付；任务保持 in-progress，等待原 Claude 配合与 Desktop 独立验收。** 接口说明已先写入 `.scratch/etraderbot-foundation/coordination/08-readonly-tool-example.md`，需要使用者转交，不假设原 Claude 已收到。

**后续展示补充已交付**：[真实调用状态与安全摘要](eTraderBot-foundation-08-tool-display-backend.md)。原工具 structuredContent 不能直接供聊天页面读取，现已新增持久化摘要及普通聊天 Run 查询验证。下文保留最初交付证据；其中“无迁移 / RPC 变更”和“页面可直接读 structuredContent”仅描述初次实现，当前兼容字段、迁移和页面要求以上述补充及最新接入说明为准。前端补充与 Desktop 整票验收仍待完成。

## 交付范围

复用现有 MCP Streamable HTTP、连接配置、加密 secret、指定 Bot / 工具白名单、实时身份检查、工具审批和 Task/Run 机制。新增样例只提供 `read_synthetic_load`，用固定地址的 HTTP GET 读取合成负荷预测。模型参数只有 date / version；不能通过参数更换工作区、用户、Bot、凭据或目标 URL。

正常响应带合成来源、固定工作区 Space ID、版本、生成时间、Asia/Shanghai 时段和 `candidateOnly:true`。夹带错误范围、未知版本、非法时段、非 JSON 或超限数据均拒绝，不把候选读取写成正式业务证据。数据固定为 2026-11-08 的两个虚构小时，12.5 / 13.5 MWh，不是全天总量、实际计量或净收益。

超时、不可达、格式不符、源鉴权失败、无数据和非法请求有分别的错误码；MCP `isError:true` 保留诊断，原执行器将调用记录为 failed。没有失败后伪造结果、缓存成功回填或新增自动重试循环。源本身不可达时仍使用原 MCP 健康 / 传输错误。

没有修改既有运行时鉴权或通用审批实现：本票隔离测试确认现有机制已满足这些调用路径。原审批策略仍生效，风控 Bot 查询后仍保持 risk 角色，不新增交易授权。工作区 / Bot / 分配撤销测试覆盖**下一次工具实际调用前**发生的变化；不声称能回收已交付资料或取消已发往外部的请求。

## 文件与兼容性

| 文件 | 本轮改动 |
| --- | --- |
| `packages/contracts/src/readonly-source.ts` | 严格输入、候选数据及失败结果 schema / 类型 |
| `packages/contracts/src/index.ts` | 仅追加上述共享导出，保留已有导出及其他票修改 |
| `packages/adapters/src/examples/readonly-source.ts` | 合成本地 GET 源、标准 MCP 服务、凭据校验、限时 / 限量读取及响应校验 |
| `packages/adapters/src/examples/readonly-source.test.ts` | 13 项真实本地 HTTP / MCP 协议定向用例 |
| `packages/adapters/src/cli/readonly-source-example.ts` | 显式临时配置启动，支持 source / mcp / both；不加载应用 `.env` 或访问业务库 |
| `packages/testkit/src/readonly-source.postgres.test.ts` | 8 项隔离认证 HTTP / PostgreSQL / 原执行器与真实 MCP 用例 |
| `docs/integration/eTraderBot-readonly-tool-example.md` | 下一位开发者的配置、授权、契约、演示和失败复测说明 |

没有新增或改变 RPC 输入输出、迁移、正式业务证据结构、模板权限、算法启用或交易授权。前端可复用原有配置与工具消息；成功 MCP 的重复 text 会被既有连接器去重，应读取保留的 `structuredContent`，不能把 `content:[]` 单独判为无结果。

该样例只监听 loopback、使用 `synthetic-` 模拟凭据，外部源的工作区在启动配置固定；操作者须与连接登记业务对应。它不是生产多租户认证服务或真实交易接口。相关生产改造不在本票范围。

## 实际验证

证据：`.scratch/etraderbot-foundation/08/backend-20261107/`。隔离 runner 复用仓库 Testcontainers / process helpers，覆盖三条数据库 URL、使用每文件克隆库及临时数据目录，预检 3593/5663；应用 HTTP 在进程内，样例源使用随机监听端口，不碰 Desktop 服务。完成后只清理本轮容器、临时数据及 CLI smoke 进程。

| 命令 / 证据 | 实际结果 |
| --- | --- |
| `pnpm exec tsx .scratch/etraderbot-foundation/08/backend-20261107/run.mts packages/testkit/src/readonly-source.postgres.test.ts packages/testkit/src/live-business-authorization.postgres.test.ts apps/api/src/workspace-isolation.postgres.test.ts apps/api/src/mcp-agents.postgres.test.ts`，`postgres-final.log` | 4 文件 19 项通过，退出 0：本票 8、05 实时授权 4、工作区隔离 5、既有 MCP 分配 2 |
| 新增直接连接器测试补齐 AdapterContext.signal 后，`run.mts packages/testkit/src/readonly-source.postgres.test.ts -t 'rejects another business'`，`cross-business-recheck.log` | 1 通过，7 未选中，退出 0；不把未选中算作新增通过 |
| `pnpm exec vitest run packages/adapters/src/examples/readonly-source.test.ts packages/adapters/src/mcp-connector.test.ts packages/adapters/src/remote-mcp.test.ts packages/adapters/src/tool-result-error.test.ts`，`unit-final.log` | 实际执行 3 文件 179 项通过，退出 0；最后一个过滤路径不存在，未计入验证 |
| `pnpm exec vitest run packages/adapters/src/run-tools.test.ts`，`tool-errors.log` | 补跑真实存在的工具结果分类测试，1 文件 8 项通过，退出 0；定向单元合计 187 项 |
| `pnpm --filter @rakazo/contracts check`、`pnpm --filter @rakazo/adapters check` | 均通过，退出 0，`types-contracts.log` / `types-adapters-final.log` |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/08/backend-20261107/tsconfig.json` | 新测试及依赖聚焦类型检查通过，退出 0，`types-testkit-recheck.log`；不是全仓 check |
| 文档 CLI 的临时配置 + 标准 initialize / tools/list / tools/call，`cli-smoke.log` | 两个组件真实启动，来源 / 数值校验通过，输出不含模拟凭据，进程及临时配置已清理，退出 0 |
| 本轮 6 个 TS 文件 Biome、`git diff --check`、文档相对链接检查 | 通过，见 `biome-final.log` / `diff-check.log` / `docs-links.log` |

新增验证明确覆盖：

- 配置时先禁用，限定一个 Bot 与一个工具，再启用；凭据密文、列表 / 工具 schema / 结果 / 消息不含模拟 token。
- 原队列产生 Run 并调用真实 MCP；返回可追溯的候选来源，业务证据逐项不变，查询不生成交易 grant 或改变 risk 角色。
- 运行已经发现并缓存工具后，分别取消 Bot 分配、清空工具白名单、禁用源、删除当前成员资格、归档 Bot，后续调用均拒绝；未改写历史业务证据。
- 同用户另一业务不能列出、重新配置或授权旧源；未分配 Bot 及跨业务 Bot 知道 source route 仍无法读取。
- 实际网络超时 / 关闭源 / 错误 JSON / 错误结构 / 错误范围、日期、版本及时段 / 源 401 / 无数据；失败没有 periods 或原始秘密正文。源从 503 恢复后，主动重试可正常读取。

开发过程失败如实保留：`source-red.log` 为样例尚未实现；`source-first.log` 为测试错误地要求保留被既有连接器去重的 text；`types-adapters-first.log` 为 unknown 结果未解析；`postgres-first.log` 为 query 命名正常触发原审批规则，已改为 read 命名；`postgres-authority.log` 的第二业务 fixture 用错创建上下文，被 RLS 正确拒绝，按既有 fixture 约定修正；`types-testkit-final.log` 缺少必需 signal 的测试类型错误已修正。这些不宣称为被修改的产品权限缺陷。

开始快照记录的 853 个 Web、既有 Desktop 验收及 04 实现 / 测试文件核对无差异，见 `protected-comparison.json`。其他已存在改动保留，没有全仓格式化。

## Desktop 待验收与限制

完整步骤见 [接入文档](../integration/eTraderBot-readonly-tool-example.md#完整演示与-desktop-接续)。请先将协调文件交原 Claude，确认现有页面能安全完成指定 Bot 配置、展开 structuredContent、显示错误，再由 Desktop 在独立库 / 数据目录 / 端口验收。

至少记录页面配置与密钥保存后状态、一次正常 Bot 查询及来源、撤销后拒绝、源断开及恢复重试、业务证据与权限未变化。既有分配 replace 是全量替换，页面须保留 Bot 的其他 MCP 连接。

本轮没有修改前端，没有运行浏览器、Electron、原生设备、真实模型或真实接口、Graphile 多进程验证及全仓 CI。确定性运行时与真实 MCP 验证了工具执行路径，未证明真实模型对来源、合成属性和失败的解释质量。CLI 不自行勾选最终验收或关闭工单，不开始 09。
