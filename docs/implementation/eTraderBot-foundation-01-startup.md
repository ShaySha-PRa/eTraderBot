# 01：启动与分支切换保留业务数据

日期：2026-11-06。基准 `de2b7967`，分支 `feat/platform-foundation`。
本记录对应 `.scratch/etraderbot-foundation/issues/01-startup-data-preservation.md`。
实现和定向回归已完成；Desktop 实际页面复测待进行。未提交或推送，不包含 07 的页面修改。

## 变更与原因

原启动器有四种会改变或丢弃数据目标的行为：配置库不可达时改连托管容器；
分支迁移并入主线后删除分支库和目录；缺少完成标记时删除重建；源库占用导致复制失败时创建空库。
隔离回归分别复现了回退、合并后换库、空库替代和归属不明资源被重用/替换。
另发现 `REALTIME_DATABASE_URL` 可以仍指向原共享库，已一起修正。

现在 `scripts/dev.mjs`：

- 配置了数据库就核对运行、迁移和实时连接的主机、端口和库名；不一致即停止。
  迁移连接不可达时明确报错，不尝试 Docker 或其他数据库。没有配置任何数据库 URL 时，
  才保留原有的托管本地 PostgreSQL 启动方式。
- 输出配置目标、最终目标和文件目录；不输出用户密码、URL 参数、令牌或完整连接串。
  原有迁移命令仍负责首次创建运行身份，迁移后检查实际运行/实时连接，再启动服务。
- 普通启动中没有 `DROP DATABASE`、递归文件删除或分支库回收。迁移合并、删除 Git 分支
  都不再触发数据清理。本票没有另建清理平台或清理命令。
- 自动模式继续复用本分支的既有数据库及目录，即使已无独有迁移；新迁移分支仍可复制
  原库及配套文件。源库正被使用、权限不足或文件复制失败时不创建空库继续运行。
- 已有库的完成标记必须属于当前仓库与分支。归属不明、目录缺失、仅剩附件目录时停止；
  不猜测、不覆盖。中断的复制保留库及部分文件，不写完成标记，再次启动也会拒绝替换。
- `pnpm dev --existing` 明确使用配置中的数据库和绝对 `DATA_DIR`，不派生分支库。
  适合跨分支继续查看同一套已确认数据。此模式仍运行正常迁移，不是绕过迁移或权限。
- 运行、迁移和实时连接共同指向选定库。保留原来的端口选择、迁移锁及四服务启动流程。

只改启动脚本、新增启动回归和启动文档；没有改数据模型、交易权限、API 契约或业务状态。

## 日常启动和恢复

普通自动隔离模式仍使用 `pnpm dev`。相对 `DATA_DIR` 按原规则相对主 checkout 解析；
跨分支固定数据时，优先将以下配置写入当前 checkout 的未跟踪 `.env`，再运行 `pnpm dev --existing`：

- `DATABASE_URL`：选定库的运行身份连接；
- `DATABASE_MIGRATION_URL`：同一主机、端口和库名的迁移身份连接；
- `REALTIME_DATABASE_URL`：可不设置；设置时须与源目标一致，允许不同身份；
- `DATA_DIR`：该库对应附件/电脑文件的**绝对目录**，必须存在。

先检查启动输出的最终目标。没有配置库时自动创建的本地开发库，不是连接失败后的恢复路径。
第一次复制分支需要源库无其他客户端连接；不要为了启动一个新分支而强停其他工作区。
可以等待源使用者结束，或显式选用已有的隔离副本。新建的空数据集可主动创建空目录，
已有数据集缺少目录时必须先恢复，不能创建空目录假装恢复完成。

遇到错误时：

1. 停止本次失败的启动，保留报错中的目标和目录。不要改指向另一库试图让页面出现。
2. 只读确认配置服务、库、归属标记和目录；备份现存数据库、文件及对应加密配置。
   数据库备份成功不能证明附件已保留。
3. 源库占用时在源工作区结束后重试。复制中断或归属不明时先核对/恢复匹配的库和文件，
   不依赖重跑启动器删除半成品。
4. 必须从备份恢复时，先恢复到新的隔离库和新目录，核对记录、引用及附件内容，
   再通过 `--existing` 明确选择它们。不要用新目录覆盖原现场。
5. 不再使用的库和目录由操作者在确认无使用者、有可用备份后单独处理；普通启动不承担清理。

## 验证记录与边界

数据库回归使用 Testcontainers PostgreSQL 18、临时 Git 仓库、临时文件目录和合成业务。
测试代码没有把原 checkout、业务库或附件目录作为测试目标。与 07 分离：集成命令指定
API 3511 / Web 5581；实际启动测试另外申请空闲端口。没有启动 Playwright 或 Electron。

| 验证 | 结果/范围 |
| --- | --- |
| 配置失败与脱敏 | 不可达目标、无效 URL、迁移/实时目标不一致、缺少显式目录均拒绝；不调用 Docker、不泄漏合成密码/令牌、不启动服务。 |
| 自动隔离与合并 | 从包含真实业务模型记录的源库复制；重复启动、模拟迁移并入主线后目标一致，业务证据、Bot、工单和附件内容完整可读。 |
| 跨分支与其他工作区 | `--existing` 在另一分支选中原库/文件，另一库保持活动连接；两边记录与附件相同，原活动连接继续可用。 |
| 故障恢复 | 源库占用、缺失/异属标记、缺少附件目录、孤立目录和文件复制失败均受控停止；已存资源保留，中断后重试不替换。 |
| 实时读取目标 | 实时连接跟随最终选库，不能仍读取原共享库。 |
| 真实启动和重启 | 在隔离库上实际执行启动器及迁移，创建新的运行身份，启动 Web/API/worker/supervisor，随后完整停止再启动；Web `/app` 返回 200 和入口 HTML，API `/ready` 为正常状态，worker 报告就绪；每次启动前后业务、工单、Bot、证据和附件内容一致。 |

`API_PORT=3511 WEB_PORT=5581 pnpm test:integration --spec=dev-startup`：
**16 项通过**（6 项配置/失败测试、10 项 PostgreSQL 场景，含真实四服务启动两次）。
其他 CLI 场景只在进程边界替换 Docker/服务启动，选库、Git、文件及 PostgreSQL 都是真实行为；
真实启动场景没有替换 pnpm、迁移或服务。合成工单引用一个合成文本附件，不声称覆盖所有上传格式。

`pnpm exec vitest run packages/testkit/src/dev-startup.postgres.test.ts`：6 项通过，
10 项数据库测试按设计跳过，不能单独将此命令写成数据库验收通过。
`node --check scripts/dev.mjs`、两个改动源码/测试文件的 Biome 和 diff 检查通过。
`node --test scripts/pnpm.test.mjs`：Windows 专属 1 项在 Linux 上跳过。

新增测试的独立 TypeScript 检查通过。`pnpm --filter @rakazo/testkit check` 未通过：
已有 `packages/testkit/src/authorization.test.ts:238` 的 `TS2345`（参数不能赋给 `never`）。
排除本票新增文件再检查仍得到相同错误，该文件与 HEAD 一致；没有改动其他测试来掩盖失败。
复核配置与分阶段输出保存在本机 `.scratch/etraderbot-foundation/01/`，不包含真实凭据。

没有运行全仓 CI、真实模型、公司接口、实盘、原生 Windows CLI、Electron 或移动设备测试。
Web HTTP 200 不等同于浏览器已经渲染出历史与附件；Desktop 的实际页面验收仍待进行。

## Desktop 定向复测

先与 07 确认浏览器空闲。使用独立 PostgreSQL 和绝对临时 `DATA_DIR`，不得使用原业务库。
下面是仅含合成密钥的本地隔离样本；如端口占用请整体换一组，并同步 URL。

```bash
# 在本 worktree 运行；新建一套仅供本票复测的数据。
export STARTUP_TEST_DIR="$(mktemp -d /tmp/etrader-startup-desktop.XXXXXX)"
export STARTUP_TEST_CONTAINER="etrader-startup-desktop-$(date +%s)"
mkdir -p "$STARTUP_TEST_DIR/data"
docker run --rm -d --name "$STARTUP_TEST_CONTAINER" \
  -e POSTGRES_USER=startup_owner -e POSTGRES_PASSWORD=synthetic-owner \
  -e POSTGRES_DB=startup_review -p 127.0.0.1:55431:5432 postgres:18-alpine
export DATABASE_MIGRATION_URL='postgres://startup_owner:synthetic-owner@127.0.0.1:55431/startup_review'
export DATABASE_URL='postgres://startup_runtime:synthetic-runtime@127.0.0.1:55431/startup_review'
export REALTIME_DATABASE_URL="$DATABASE_URL" DATA_DIR="$STARTUP_TEST_DIR/data"
export NODE_ENV=test AGENT_RUNTIME=scripted SANDBOX_PROVIDER=fake WAKEUP_DRIVER=memory
export CLOUD_AGENT_PROVIDER=emulator RAKAZO_LIVE_MODEL_CATALOG=off
export BETTER_AUTH_SECRET=synthetic-startup-auth-secret-at-least-32
export ENCRYPTION_KEY=synthetic-startup-encryption-key-at-least-32
export SCREEN_PROXY_SECRET=synthetic-startup-screen-secret-at-least-32
export SANDBOX_SUPERVISOR_TOKEN=synthetic-startup-supervisor-secret-at-least-32
export SIGNUPS_ENABLED=true SIGNUP_ALLOWLIST='' LOCAL_AUTO_LOGIN_EMAIL=''
export WEB_PORT=5581 API_PORT=3511 SUPERVISOR_PORT=7291 RAKAZO_DEV_HOST=127.0.0.1
export WEB_ORIGIN=http://127.0.0.1:5581 BETTER_AUTH_URL=http://127.0.0.1:5581
export API_URL=http://127.0.0.1:3511 API_PROXY_TARGET=http://127.0.0.1:3511
export SANDBOX_SUPERVISOR_URL=http://127.0.0.1:7291
# 等待下面的就绪检查成功，再启动。不得使用 docker compose down -v。
docker exec "$STARTUP_TEST_CONTAINER" pg_isready -U startup_owner -d startup_review
pnpm dev --existing
```

1. 在输出中确认仅指向 `startup_review` 和上述临时目录。页面打开该样本地址，使用合成账号注册。
2. 通过现有界面创建模拟业务、专业 Bot、P25 周期和一张工单；上传一个合成文本附件。
   记录业务/周期/工单 ID、证据版本、附件名称及下载 SHA-256，保存页面截图。不要配置真实模型或真实接口。
3. 停止这次前台启动进程后，用同一配置重新执行 `pnpm dev --existing`。
   页面重新登录/刷新后核对相同 ID、证据、工单和附件下载内容，不能以“页面能打开”代替记录比对。
4. 配置一个不存在的测试库或错误的测试端口，启动应失败并打印脱敏目标；不得出现新空业务页或启动备用库。
   恢复正确配置后再启动，原样本仍可读。不要停原工作区的数据库来构造故障。
5. 合并/切换分支及另一工作区活动连接的自动化证据来自本票 CLI/PostgreSQL 回归。
   若需要再次页面验证切分支，使用临时副本，并显式固定同一隔离库/目录；不要切换他人的工作分支。
6. 留存实际截图、HTTP/控制台错误、文件摘要和逐项结果。复测结束只停止本次创建的容器，
   保留临时目录及证据待确认；不要自动删除原工作区或其他工作区资源。

需要验证备份恢复时，可在上述**隔离样本**停止应用后执行以下步骤。原测试库和目录仍保留，
新库名若已存在则应停止操作，不能加入覆盖或清理参数。保留前面设置的合成加密配置。

```bash
# 只针对上面新建的 STARTUP_TEST_CONTAINER；不要替换成原开发数据库容器。
(
  set -e
  umask 077
  docker exec "$STARTUP_TEST_CONTAINER" pg_dump -U startup_owner -d startup_review -Fc \
    > "$STARTUP_TEST_DIR/database.dump"
  tar -czf "$STARTUP_TEST_DIR/files.tar.gz" -C "$STARTUP_TEST_DIR/data" .
  docker exec "$STARTUP_TEST_CONTAINER" createdb -U startup_owner startup_recovered
  docker exec -i "$STARTUP_TEST_CONTAINER" pg_restore -U startup_owner \
    --no-owner --dbname=startup_recovered < "$STARTUP_TEST_DIR/database.dump"
  mkdir "$STARTUP_TEST_DIR/recovered-data"
  tar -xzf "$STARTUP_TEST_DIR/files.tar.gz" -C "$STARTUP_TEST_DIR/recovered-data"
)
# 上一步成功后，再显式选择恢复副本；仍不能用页面空白/重新建 Bot 代替原记录。
export DATABASE_MIGRATION_URL='postgres://startup_owner:synthetic-owner@127.0.0.1:55431/startup_recovered'
export DATABASE_URL='postgres://startup_runtime:synthetic-runtime@127.0.0.1:55431/startup_recovered'
export REALTIME_DATABASE_URL="$DATABASE_URL" DATA_DIR="$STARTUP_TEST_DIR/recovered-data"
pnpm dev --existing
```

这组手工恢复操作是 Desktop 的待执行步骤，本票没有将未运行的 dump/restore 页面流程列为通过。
