# 模拟交易批准与执行

本批提供应用服务及认证 RPC，供后续页面、Bot 工具和后台任务复用。外部 agent 继续遵循 [外部契约](../integration/eTraderBot-interface-list.md)，无需实现这里的审批或额度逻辑。

## 已实现流程

1. 使用者明确创建模拟业务范围，分别指定算法审批人和交易授权人。两人必须是当前 Space 成员，也可同为创建者。
2. 运行模拟分析，准备交易意图。服务端固定具体订单、范围、算法版本、规则版本、有效期及内容摘要，并重新校验风险。
3. 算法审批人批准确定的引擎内容；交易授权人逐笔批准具体意图，或建立限额授权。两项批准分别检查，不能互相替代。
4. 范围创建者提交模拟执行。意图、数据时效、交割时段、版本启用、批准/授权与额度全部重新核验；执行登记、额度占用、首次回执核销及审计在同一数据库事务中提交。
5. 按原请求查询回执。相同请求重试返回原执行；相同键配不同内容拒绝，同一意图换键再提交也拒绝。

创建范围、批准、授权、撤销及退役版本均要求已登录且近期完成身份确认的会话，并检查指定业务职责。现有 `IDENTITY_CONFIRMATION_REQUIRED` 和客户端身份确认流程继续适用。接口不接受模型自报的审批身份、`approved` 标志或额度消耗值；Space 管理身份不会自动取得交易审批权限。

## RPC 清单

方法位于既有 RPC 客户端的 `trading` 下；类型与字段以 [共享契约](../../packages/contracts/src/trading-control.ts) 为准。

| 方法 | 输入关键字段 | 行为 |
| --- | --- | --- |
| createDesk | scope、algorithmApproverUserId、tradeApproverUserId | 创建明确的模拟业务范围与审批职责 |
| participants | 空对象 | 当前 Space 的成员标识及名字，不返回邮箱 |
| bindBot / unbindBot | deskId、botId、绑定时的 role | 已确认身份的范围创建者配置 Bot 角色 |
| desks | 空对象 | 最近 100 个可见范围 |
| desk | deskId | 范围及各类最近 100 条版本、意图、授权、执行与审计 |
| prepareIntent | deskId、analysisId、expiresAt | 固定交易意图，形成待批准版本记录 |
| approveAlgorithm | deskId、versionId、expectedArtifactHash | 指定算法审批人启用版本 |
| retireAlgorithm | deskId、versionId | 指定算法审批人停止后续使用版本 |
| approveIntent | deskId、intentId、expectedIntentHash | 指定交易授权人逐笔批准 |
| createGrant | deskId、versionId、perTradeLimitCny、cumulativeLimitCny、expiresAt、可选 botId / allowCancellation | 指定交易授权人创建限额授权 |
| revokeGrant | deskId、grantId | 指定交易授权人撤销后续提交资格 |
| executeSimulation | deskId、intentId、clientRequestId、expectedIntentHash、可选 grantId | 执行已批准的模拟意图 |
| executionByRequest | deskId、clientRequestId | 查询最新持久化回执及完整历史，授权撤销后仍可查（不推进状态） |
| configureSimulation | deskId、scenario | 经身份确认的范围所有者配置后续新订单的模拟场景 |
| reconcileExecution | deskId、executionId、expectedSequence | 核对已提交订单；旧序号返回当前记录，未来序号拒绝 |
| cancelSimulation | deskId、executionId、clientRequestId | 经身份确认的指定交易授权人撤单；Bot 走独立权限检查 |

## 计量与隔离

- 范围固定主体、账户、资产、地区、市场、产品、业务阶段和环境。新参数或引擎内容形成新版本，新版本不会继承旧授权。
- 单笔指整个意图。额度为 CNY 毛名义金额：逐行按 `abs(限价) × 电量` 向上取 6 位小数后累加；买卖不抵消，负价也占用额度。它不表示净收益。
- 累计窗口为授权创建至到期的生命周期。成交确认额计入 `usedCny`，不能重置；未确定的剩余毛名义金额计入 `reservedCny`。新提交检查 `usedCny + reservedCny + 新意图总额 <= cumulativeLimitCny`，逐行按累计成交数量取整。明确拒单或撤单释放未成交占用；已成交核销保留。结果不确定或场所持续不可用继续占用额度。数据库仅锁对应业务范围，分别协调额度、撤销、版本退役和提交。
- 撤销与提交的先后以同一范围锁决定：已提交操作保留回执，撤销提交后阻止新增操作。查询和相同请求重试不会再次消耗额度。
- 数据库保护已审核的版本、意图、范围、限额、回执及审计内容，正常账号/Space 删除仍可级联清理。
- 业务记录仅范围创建者及两类明确指定的审批人可见，同时受 Space 行级隔离。原分析保持原用户/Space 隔离，准备意图时将其审核证据明确放入该业务范围。
- 版本保留算法、校验、定点运算的源码表示、输入 schema 与 Node 版本摘要。执行只使用当前载入且与批准内容相符的引擎；归档代码不会在 API 中被求值。旧引擎不可用时拒绝重放或新执行，历史记录仍可查询。

## 当前边界

内置模拟器提供七个明确的 `synthetic` 场景：`immediate_fill`（兼容旧行为）、`partial_fill`、`timeout`、`rejected`、`pending`、`cancel_timeout`、`unavailable`。部分成交遵循电量步长，一步订单先保持受理；显式核对推进场景，提交超时先未知再部分/受理后全成，撤单超时先未知、核对后撤销，持续不可用不会自动恢复。每次提交固定当时场景，后续配置不改变旧订单。

`TradingExecution.receipt` 保留首次不可变证据，`TradingExecutionEvent` 追加后续回执。DTO 的 `receipt` 为当前回执，`receipts` 为含首次的有序历史。重复提交、取消、核对和并发终态竞争均不会重复核销。学习资料固定最新回执及完整历史，旧学习输入不覆盖。

本轮只验证内部合成场所，尚未模拟真实市场撮合、验证收益或调用公司网络。真实适配器仍需独立完成网络提交登记、故障恢复、外部回执去重与对账。

当前执行者可以是模拟范围创建者，也可以是明确绑定的交易 Bot。`createGrant` 的可选 `botId` 指定执行 Bot，未指定表示范围创建者；Bot 准备的意图也固定其 `botId`。不同 Bot、个人和 Bot 之间不能交换意图或授权。执行时在范围锁内重新检查绑定和角色，防止解除绑定后继续提交。

Bot 的 `trading` 内置工具支持 `scopes`、`context`、`analyze`、`prepare`、`execute`、`reconcile`、`cancel`，不暴露人工批准或授权方法。中长期角色仅在中长期场景写入，现货角色覆盖日前/日内/实时，风控及复盘不能下单或撤单，可查询和核对已提交状态。Bot 撤单要求订单属于自身、角色有写权限、原限额授权仍有效且明确允许撤单；逐笔下单批准不自动授权 Bot 撤单。人工指定交易授权人可在原授权撤销后处理既有订单。身份来自服务端 Run，不能由模型参数指定；仅具备绑定的运行会发现该工具。

Web/桌面入口为 `/app/trading`，移动入口为账号菜单的 Trading。移动端覆盖查询回执历史、核对、人工撤单、算法/交易批准、退役与撤销授权；配置范围、模拟场景、授权和 Bot 绑定暂由 Web 完成，并显示相应提示。每日/手动学习、参数候选和待批准版本见[学习流程](eTraderBot-learning-api.md)。论文算法实现按使用者决定搁置。审批证据目前证明确定性的硬约束检查，不表示论文复现、策略优于人工或实盘有效。


## Bot 模板入口修订

`bots.create` 可带可选的 `tradingRole`（`mid_long_term` / `spot` / `risk` / `review`）；返回的 Bot 保留该字段，通用 Bot 为 `null`。模板默认指令由共享实现提供，不启动没有范围的模型介绍任务。普通更新接口不接受角色更改，复制 Bot 保留模板但不复制范围绑定和交易授权。

`trading.createDesk` 新增可选 `botId`：验证当前使用者拥有该模板 Bot、模板与阶段匹配，然后在同一事务内保存范围、角色绑定、默认学习计划和审计。省略时保留已有服务调用行为。`trading.desks({ botId })` 只返回当前使用者拥有的该 Bot 已绑定且仍有权访问的范围；省略参数仍按原有人工业务身份返回可访问范围。

Web 入口为 `/app/:botId?workspace=trading` 和 `/app/:botId?workspace=learning`，聊天使用 `/app/:botId`。业务页可连接和断开范围；角色从持久化模板取得。页面中的人工审批不授予 Bot 权限，工具调用仍使用服务端 Run 身份并验证范围绑定、阶段和授权。对使用者分配的审批范围单独标明人工上下文。
