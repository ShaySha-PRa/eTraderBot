# 外部快照样例校验记录

2026-11-03 当次离线校验，文件来源为 `docs/integration/fixtures/snapshots/`。未改写样例。

共 49 份，9 份可通过基线计算，40 份拒绝。全部 JSON 结构可解析，但跨字段和业务约束尚未全部满足。

## 修正口径

- `STALE_DATA`：快照与规则的来源有效期必须重叠；各交易日应配对应规则来源时间，不能沿用已过期的包络。
- `INVALID_INPUT`：当前失败均为成本段电量之和小于可发能力。请按同一 MWh 口径补齐成本段或订正可发能力，不要只修改校验器。
- `PRICE_STEP_MISMATCH`：售电可执行报价须符合规则步长。公开价格均值可保留原始旁路记录，生成模拟报价时应明确、可追溯地量化；不能把预测均值直接当成合法可执行报价。

模拟运行与数据来源分别记录，公开历史资料保留 `source.kind=user`。校验在数据与规则均已观察到的最早时刻重放，不会把历史资料刷新为当前可交易资料。来源真实性、发布时刻和预测是否含未来实际数据仍需资料提供方核对。

## 拒绝的文件

| 文件（相对 snapshots/） | 原因 |
| --- | --- |
| `generator/snap-gen-jspv-20250310.json` | `INVALID_INPUT` |
| `generator/snap-gen-jspv-20250311.json` | `INVALID_INPUT` |
| `generator/snap-gen-jswind2-20250320.json` | `INVALID_INPUT` |
| `generator/snap-gen-jswind2-20250321.json` | `STALE_DATA` |
| `generator/snap-gen-jswind2-20250322.json` | `STALE_DATA` |
| `generator/snap-gen-jswind2-20250323.json` | `STALE_DATA` |
| `generator/snap-gen-jswind2-20250324.json` | `STALE_DATA` |
| `generator/snap-gen-sdcoal2-20250320.json` | `INVALID_INPUT` |
| `generator/snap-gen-sdcoal2-20250321.json` | `STALE_DATA` |
| `generator/snap-gen-sdcoal2-20250322.json` | `STALE_DATA` |
| `generator/snap-gen-sdcoal2-20250323.json` | `STALE_DATA` |
| `generator/snap-gen-sdcoal2-20250324.json` | `STALE_DATA` |
| `generator/snap-gen-sdwind-20250310.json` | `INVALID_INPUT` |
| `generator/snap-gen-sdwind-20250311.json` | `INVALID_INPUT` |
| `generator/snap-gen-shcoal-20250310.json` | `INVALID_INPUT` |
| `generator/snap-gen-shcoal-20250312.json` | `INVALID_INPUT` |
| `retailer/snap-ret-js01-20250310.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-js01-20250311.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-sd01-20250310.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-sd01-20250312.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-sd02-20250320.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-sd02-20250321.json` | `STALE_DATA` |
| `retailer/snap-ret-sd02-20250322.json` | `STALE_DATA` |
| `retailer/snap-ret-sd02-20250323.json` | `STALE_DATA` |
| `retailer/snap-ret-sd02-20250324.json` | `STALE_DATA` |
| `retailer/snap-ret-sh01-20250310.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-sh01-20250311.json` | `PRICE_STEP_MISMATCH` |
| `retailer/snap-ret-sh02-20250321.json` | `STALE_DATA` |
| `retailer/snap-ret-sh02-20250322.json` | `STALE_DATA` |
| `retailer/snap-ret-sh02-20250323.json` | `STALE_DATA` |
| `retailer/snap-ret-sh02-20250324.json` | `STALE_DATA` |
| `storage/snap-sto-sdbess4-20250321.json` | `STALE_DATA` |
| `storage/snap-sto-sdbess4-20250322.json` | `STALE_DATA` |
| `storage/snap-sto-sdbess4-20250323.json` | `STALE_DATA` |
| `storage/snap-sto-sdbess4-20250324.json` | `STALE_DATA` |
| `storage/snap-sto-sdbess4-negprice-20250325.json` | `STALE_DATA` |
| `storage/snap-sto-shbess5-20250321.json` | `STALE_DATA` |
| `storage/snap-sto-shbess5-20250322.json` | `STALE_DATA` |
| `storage/snap-sto-shbess5-20250323.json` | `STALE_DATA` |
| `storage/snap-sto-shbess5-20250324.json` | `STALE_DATA` |

## 复查命令

```bash
pnpm exec tsx packages/core/scripts/validate-trading-fixtures.ts
```

文件更新后应重新运行，以新结果替代本次记录。该命令发现拒绝项时退出码为 1；形状和数值校验通过不代表真实收益或市场规则已经验证。
