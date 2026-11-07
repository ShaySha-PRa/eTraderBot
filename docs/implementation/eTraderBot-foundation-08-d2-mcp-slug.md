# 08-D2：中文 MCP 名称的标识冲突

2026-11-07，`platform-foundation` / `feat/platform-foundation`，开始 HEAD `c512867f4f97c458c2d26c9c9e895d65a88022b3`。依据 08 协调文件（本地证据 `.scratch/etraderbot-foundation/coordination/08-readonly-tool-example.md`，不在仓库中） 与 Desktop 已有真实调用验收（本地证据 `.scratch/etraderbot-foundation/acceptance/runs/accept-08-20261107-f92d8a/report.md`，不在仓库中）。本次完成 D2 共享逻辑及后端回归；D1 前端由原 Claude 处理，两项交付后仅做定向复测。未提交、推送、关票或启动 09。

收尾时观察到并行会话已将 HEAD 推进至 `29f80c493acea0f467c348f1197c2f5fb5cfef88`（最新为 07 的提交）；本会话没有执行 Git 写操作，D2 文件仍是未提交改动。工作区源文件及已冻结验收证据核对无变化，保留外部提交和原未提交内容，不回退 HEAD。见证据目录 `concurrent-work.json` / `final-status.txt`。

## 原因与改动

页面 `McpServersOverlay` 与 Bot `parseMcpServerToolArgs` 都调用 `@rakazo/core.deriveMcpSlug`。旧逻辑丢弃所有非 ASCII 字符，故 `08 基线分配` 和 `08 合成只读样例` 均变成 `08`；纯中文还依赖毫秒时间戳，无法保留名称区别。数据库拒绝重复标识是正确行为，原“同名”错误说明不准确。

新逻辑只对含非 ASCII 的新名称增加稳定后缀：trim / NFC / lowercase 后，对完整 UTF-8 名称计算 FNV-1a 64 位摘要；最多 47 字符 ASCII 前缀（纯中文为 mcp）加连字符及 16 位十六进制后缀，总长最多 64。摘要在前缀截断前使用完整名称，浏览器与 worker 使用同一纯函数，无新依赖或 Node 专用 API。纯 ASCII 名称保留原规则，不改已有英文工具命名习惯。

现有数据库唯一索引、跨可见范围的冲突预检、事务及审批机制全部保留；有限摘要不取代唯一性约束。相同归一化名称仍派生相同 slug，重复请求继续拒绝，不自动增加序号或覆盖连接。显式 RPC slug 保持显式输入语义，旧客户端继续发送 `08` 时仍可能冲突，须加载更新后的页面代码。

没有迁移或扫描旧连接，也没有重新计算其 slug。页面编辑和启用仍携带已存 slug，既有 `mcp__<slug>__<tool>`、授权、密文和历史不变。Bot 仍产生原待审批卡，不因标识生成变化而获得分配。

## 文件与接口

| 文件 | 本次修改 |
| --- | --- |
| `packages/core/src/mcp.ts`、`mcp.test.ts` | 共享 Unicode 派生规则；双中文、纯中文、emoji、长前缀、NFC / 时间稳定及 ASCII 兼容回归 |
| `packages/adapters/src/mcp-server-tool.ts`、`mcp-server-tool.test.ts` | Bot 入口共享规则验证；冲突说明改成标识已存在，不再建议删除旧连接 |
| `apps/api/src/routes/mcp.ts`、`availability.ts`、`router.test.ts` | 创建唯一约束和可见范围冲突说明改成 identifier；409 / CONFLICT 不变 |
| `apps/api/src/mcp-slug.postgres.test.ts` | 3 项隔离数据库 / RPC / 实际 Bot 创建服务回归 |

另新增本记录、隔离证据说明，更新 08 协调文件及任务票。没有改前端、共享 RPC schema、数据库 schema 或唯一索引。对页面的唯一接入要求是加载新共享函数；如需错误本地化，具体英文消息及中文建议已交给 Claude。不能将其他 CONFLICT（如凭据变化）误映射为名称问题。

## 验证

证据目录：`.scratch/etraderbot-foundation/08/d2-backend-20261107/`。数据库使用新 Testcontainers、按文件克隆库及临时数据目录，配置端口 3597/5667；没有使用 Desktop 库、服务端口或附件。测试创建的只有合成账户、连接和模拟凭据；结束后清理本次资源。

| 命令 / 日志 | 结果 |
| --- | --- |
| 修复前 `pnpm exec vitest run packages/core/src/mcp.test.ts packages/adapters/src/mcp-server-tool.test.ts`；`red.log` | 6 失败、25 通过，退出 1；包含两个目标名称都为 08 的断言，确认后才修复 |
| `pnpm exec vitest run packages/core/src/mcp.test.ts packages/adapters/src/mcp-server-tool.test.ts packages/adapters/src/mcp-connector.test.ts apps/api/src/router.test.ts`；`unit.log` | 4 文件 487 项通过，退出 0 |
| `pnpm exec vitest run apps/web/src/pages/McpServersOverlay.test.tsx`；`web-unit.log` | 现有页面单元 18 项通过，退出 0；未修改该文件，不是浏览器验收 |
| `pnpm exec tsx .scratch/etraderbot-foundation/08/d2-backend-20261107/run.mts apps/api/src/mcp-slug.postgres.test.ts apps/api/src/mcp-agents.postgres.test.ts`；`postgres-final.log` | 2 文件 5 项通过，退出 0（D2 新增 3、原 MCP 分配 2） |
| `pnpm --filter @rakazo/core --filter @rakazo/adapters --filter @rakazo/api check`；`types.log` | 3 个包通过，退出 0 |
| `pnpm exec tsc --noEmit -p .scratch/etraderbot-foundation/08/d2-backend-20261107/tsconfig.json`；`types-test-final.log` | 新数据库测试及依赖的聚焦类型检查通过，退出 0 |
| 8 个修改 TS 文件 `pnpm exec biome check`、`git diff --check`、本次文档相对链接检查 | 通过，见 `biome.log`、`diff-check.log`、`docs-links.log` |

数据库回归使用实际 RPC handler、Bot 创建服务、加密存储和 PostgreSQL：

1. 先建立 legacy `slug=08`，持有模拟密文、专属 Bot 分配及 `mcp__08__read_synthetic_load` 历史。用页面相同的共享派生函数和 RPC 创建第二个中文连接成功；指定 Bot 后启用、编辑显示名保留已存新 slug。逐项比较旧连接、密文、分配和历史完全不变。显式另一名称占用 08 仍返回 CONFLICT，连接和凭据数量不增加。
2. Bot 依次创建两个中文名称，slug 各自对应共享函数；两份待审批消息可读且无模拟凭据，无 Bot 分配、没有 allBots / allSpaces 扩权。再次创建相同名称拒绝，不新增连接、密文或历史卡片。
3. 页面 RPC 与 Bot 同时发起相同 Unicode 名称创建，一方成功、一方拒绝，数据库只留一份连接和密文；只有 Bot 获胜时才有一张待审批卡。该测试是并发发起验证，没有用锁等待屏障证明特定竞争时序。

`postgres.log` 保留第一次 3 失败 / 2 通过：新测试夹具遗漏 organization member，被外键正确拒绝。补齐夹具后完整组合通过，没有为测试修改产品权限或外键。

开始快照记录 918 个 Web / 验收文件。核对时 8 个 `apps/web/test-results/chat-progress-*` 截图由并行运行更新；本会话只运行页面单元，未启动浏览器，也未恢复这些截图。Web 源码及 `.scratch` 下已冻结的 Desktop / Claude 验收证据无差异，详见 `protected-comparison.json`；原有未提交修改和删除保留。

## Claude 与 Desktop 接续

请使用者转交 同一协调文件（本地证据 `.scratch/etraderbot-foundation/coordination/08-readonly-tool-example.md`，不在仓库中） 给原 Claude；不假设文件已送达。D2 不需要新页面或 RPC 字段，若本地化冲突提示，按协调文件中两个准确的 MCP 错误消息处理，不笼统将所有 CONFLICT 归为重名。

等 D1、D2 均交付后，Desktop 沿用本轮已通过的真实调用证据，仅定向复测：

1. 加载最新页面/API/worker，在独立复测业务先用 `08 基线分配`、再用 `08 合成只读样例` 创建两条连接，两者成功且标识不同。原现场若保留旧 slug=08，无须删改；创建另一名称不再与它冲突。
2. 沿原流程指定 Bot、启用、编辑显示名并刷新；核对存储 slug、工具前缀、其他连接授权及旧历史保持。重复同名创建仍拒绝，不建议用户删除旧连接；不重复创建凭据或审批卡。
3. 如需复测 Bot 入口，只让测试 Bot 建立新连接并检查待审批卡与分配，按原审批流程处理；不能把注册成功当作已授权。后端已覆盖这一创建服务路径，真实模型触发质量本轮未重测。
4. D1 的同工具两次一成一败、单次失败、撤权后无调用场景按 Claude 交付及原真实 Run 定向核对折叠标题 / 详情，不从 steps 猜测 calls，不重跑完整真实业务周期。

本轮未运行浏览器、Electron、移动原生端、真实模型或新真实工具调用，也没有执行全仓 CI。页面单元和隔离服务回归不能替代 Desktop；D1 不由本记录宣告完成，08 不自行关票。
