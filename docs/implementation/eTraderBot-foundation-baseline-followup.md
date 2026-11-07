# 基座收尾后的类型、基线与撤权补验

日期：2026-11-07。分支：`feat/platform-foundation`。起始提交：`0ab2b3a7eb4940640eb2110aab96e41a3dbccc7b`；本记录描述专项补验时的测试修复；后续提交包含这两份测试文件及收尾文档。

## 结论与改动

testkit 类型错误和 04 留下的两组基线失败均已复现、定位并修复。真实模型调用缓存工具时撤销分配的补验通过。未修改生产权限、运行恢复、工具执行或接口契约；专项补验执行时没有提交、推送，也未在开发业务库上执行迁移。

源码只改两个测试文件：

- `packages/testkit/src/authorization.test.ts`：补齐 70 个新增受保护 RPC 的未登录拒绝用例，保留类型层面的穷尽检查。原 TS2345 是这份清单缺项造成的，不通过类型断言或删除检查绕过。
- 同一文件的 4 项历史失败：能力记录的核对改用测试已建立的 system 上下文，避免 RLS 隐藏记录并产生无上下文访问告警；模型设置测试保留 Bot 凭据库始终按工作区隔离的 `credentials` 项；删除中的工作区按现有隔离入口返回 404，仍检查不能创建 Bot、已有资源保留。沙箱销毁超时用例补充无新增 Bot 的断言。
- `packages/testkit/src/executor-turn-checkpoint.test.ts`：补齐夹具中同工作区的 Bot、电脑、有效工作区和工具调用记录存储。原 27 项失败先被身份缺失挡住；补齐后暴露的 19 项失败来自缺少 `runToolCall.upsert`，补齐该存储边界后原 27 项均通过。保留原批准、暂停、恢复、证据与副作用断言。

## 验证结果

| 检查 | 修复前 | 最终结果 |
| --- | --- | --- |
| `pnpm --filter @rakazo/testkit check` | `authorization.test.ts` 的 TS2345 | 通过，退出 0 |
| `authorization.test.ts` | 隔离 PostgreSQL 中 4 失败、29 通过，另有无上下文读取告警 | 33/33 通过，退出 0 |
| `executor-turn-checkpoint.test.ts` | 27/27 失败；补身份后 19 失败、8 通过 | 27/27 通过，退出 0 |
| 两个改动测试文件的 Biome | — | 通过 |
| 真实模型缓存工具撤权 | 原 09 只有工具不可见；实际 refused 仅有确定性执行器证据 | 本次受控时序下真实模型调用并记录 refused，通过 |

定向命令：

```sh
pnpm --filter @rakazo/testkit check
pnpm exec vitest run packages/testkit/src/executor-turn-checkpoint.test.ts --reporter=dot
pnpm test:integration --spec=authorization.test.ts
pnpm exec biome check packages/testkit/src/authorization.test.ts packages/testkit/src/executor-turn-checkpoint.test.ts
```

上方列出公开仓库的定向复跑命令；历史授权套件复用已有本地 runner，使用一次性 PostgreSQL、临时目录及进程内认证 HTTP；迁移只作用于该隔离库。checkpoint 套件使用真实 Pi 与本地模型协议夹具，不是付费模型调用。

## 真实模型缓存工具撤权

这是一项受控执行边界验收：真实模型生成工具调用，测试在将该调用交给已有执行入口前，通过正常认证 RPC 撤销当前 Bot 的 MCP 分配，然后把原调用交回原执行器。没有伪造模型工具调用、替换工具结果或直接写入工具状态。

顺序与断言：

1. 新隔离业务中的风控 Bot 获得只读 MCP 工具；运行的工具目录中实际包含该工具。合成数据源单独正向读取成功。
2. 真实模型请求 `read_synthetic_load`，参数为已登记的合成日期和版本。
3. 通过 `mcp/assignments/replace` 撤销 Bot 分配，等待成功响应，再调用缓存的原 `executeTool`。
4. 实际工具返回 `FORBIDDEN`；持久化调用只有一条，状态 `refused`，成功摘要为空。正常 `runs/detail` 回读同一拒绝状态。
5. 数据源读取计数在运行前后不变，业务证据完整记录前后一致；模型收到拒绝后完成，没有再次调用该工具。

模型连接来自已保存的隔离验收备份；备份只恢复到临时数据库，原库和原报告未修改。旧验收启动配置和开发配置不同，初次连接查找和配置不匹配不计作模型测试失败；只有成功找到可用连接后的这次实际调用计为补验。明文凭据没有写入源码、报告或日志，临时数据库及数据目录在结束后删除。

本轮共两次真实模型请求，均使用同一配置，没有模型回退。配置页连接探测使用已有目录夹具；实际 Pi 生成请求使用真实模型服务，MCP 发现与权限检查走现有实现。撤权请求是进程内认证 HTTP，没有操作浏览器；撤权时点由测试控制，不能外推为所有自然网络竞态、全部撤权类型或 Graphile 多进程场景均已验收。模型文本未做语义质量评分。

## 证据与保留范围

本地复现日志、最终日志、真实调用时间线、用量和可重跑的受控验收脚本位于 `.scratch/etraderbot-foundation/baseline-followup-20261107/`；入口为该目录的 `README.md`。原 04、09 报告保留当时失败与未验证结论，后续状态以本记录为准。

本轮没有运行全仓 CI、Electron、原生移动端、Graphile 多进程或浏览器复测。较早 Expo 依赖核对及 bot-secrets 失败未在本轮复核；testkit TS2345 和本记录列明的两组基线失败已由当前结果取代，不再列为仍未解决。
