# R4 离线 Reddit 归档

项目的「数据接入 → 离线 Reddit 归档」用于关联历史范围。工作台「探索」从外置 DuckDB 检索已关联的 Parquet。PostgreSQL 只存项目、来源、归档版本与筛选范围的引用。推流导入是独立的运维操作。

## 1. 注册来源和授权

在「运维 → 来源管理」使用已有 Reddit R4 注册配置创建或选择一个活跃的 Reddit 推送来源。来源需要 `external_ingest`、`reddit-archive` 标签，调度关闭。记录来源 UUID，供主线的 `ARCHIVE_ANALYSIS_SOURCE_ID` 使用。单节点配置一个归档根目录和一个授权来源。

管理员和 Owner 可使用该来源。普通用户需在现有运维策略中显式获得该来源的 `allowedSourceIds` 白名单权限，默认无权限。检索还需要项目可读，关联和解除关联需要项目可编辑。授权撤销、来源暂停或归档后，既有引用无法用于读取数据。独立的旧版推流机器密钥只给该来源和 `ingest` scope。

## 2. Windows 本机启动

依次在工作区安装应用依赖、完成 PG16 迁移，并安装外置 Python 插件。Python 需 3.11 或更高。

```powershell
npm ci --ignore-scripts
npm --prefix apps/web ci --ignore-scripts
npm run db:migrate
python -m venv plugins/zst-archive/.venv
$archivePython = './plugins/zst-archive/.venv/Scripts/python.exe'
& $archivePython -m pip install ./plugins/zst-archive
```

在 PowerShell 设置归档根目录并运行 CLI 检查。该目录在插件机器上，需要包含一个或多个带 `manifest.json` 的月份子目录，内含现有 `corpus/posts.parquet`、`corpus/comments.parquet` 和 `index/fts_*.sqlite`。运营时建议使用 OS 只读文件权限。索引和源文件需按归档版本保持静态，发布新归档时同步更新 manifest。

```powershell
$env:ARCHIVE_ROOT = Read-Host '输入插件所在机器上的归档根目录'
& $archivePython -m zst_archive.cli inspect --archive-root $env:ARCHIVE_ROOT
$env:ARCHIVE_SERVICE_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:ARCHIVE_DUCKDB_THREADS = '8'           # 默认 2，最大 32
$env:ARCHIVE_DUCKDB_MEMORY_LIMIT = '32GB'  # 默认 1536MB，按机器资源调低或调高
$env:ARCHIVE_DUCKDB_TEMP_LIMIT = '2GB'
$env:ARCHIVE_QUERY_TIMEOUT_SECONDS = '7'  # 默认 7，最大 60
$env:ARCHIVE_MAX_CONCURRENT_QUERIES = '1'   # 默认 1，最大 4
```

在该会话通过私有方式设置以下主线配置。归档服务凭证独立于站点会话密钥与推流密钥。示例使用同一 PowerShell 变量给两个进程供值，避免将凭证打印到日志或复制进项目文件。

```powershell
$env:ARCHIVE_ANALYSIS_ENABLED = 'true'   # 默认 false
$env:ARCHIVE_ANALYSIS_SOURCE_ID = Read-Host '输入已启用的 R4 来源 UUID'
$env:ARCHIVE_ANALYSIS_BASE_URL = 'http://127.0.0.1:8765'
$env:ARCHIVE_ANALYSIS_SERVICE_TOKEN = $env:ARCHIVE_SERVICE_TOKEN
$env:ARCHIVE_ANALYSIS_TIMEOUT_MS = '8500'
Start-Process -FilePath (Resolve-Path $archivePython).Path -ArgumentList '-m','zst_archive.service' -WindowStyle Hidden
# 使用本机开发环境的 DATABASE_URL、SESSION_SECRET 与前端 URL
$env:APP_ORIGIN = 'http://localhost:5173'
$env:ALLOW_HTTP_DEV = 'true'
npm run app:api
```

在另一个 PowerShell 窗口启动 Web 开发服务器 `npm --prefix apps/web run dev`。在项目里检测归档连接。若启用了 PR #53 的连接超时修复，可视工作量配对调高插件与主线预算，例如插件 20 秒、主线 22 秒。较短的默认主线预算兼容原有 10 秒 Fastify socket 空闲限制。

## 3. 可选容器部署

```powershell
docker build -t siftline-r4-local plugins/zst-archive
docker run --rm --name siftline-r4-local --memory 4g --cpus 2 -p 127.0.0.1:8765:8765 --mount "type=bind,source=$env:ARCHIVE_ROOT,target=/archive,readonly" -e ARCHIVE_ROOT=/archive -e ARCHIVE_SERVICE_TOKEN -e ARCHIVE_QUERY_TIMEOUT_SECONDS=7 siftline-r4-local
```

这条命令用于宿主机主线。插件与容器化主线应共享受控的私有网络，由主线用插件容器名或私网地址连接。容器内的 `127.0.0.1` 指向容器自己。跨节点部署通过私网、VPN 或 TLS 保护服务凭证。主线默认镜像和 Compose 无需启动插件，也无需安装 Python 或 DuckDB。DuckDB 的内存设置是查询预算，生产资源隔离由容器或操作系统提供。

## 4. 从项目接入和检索

1. 打开「研究 → 数据接入 → 离线 Reddit 归档」，点击「检测连接」。核对真实版本和月份。
2. 选择全部或指定月份，按需填关键词、Subreddit 和 UTC 起止时间。时间范围为左闭右开。布尔表达式支持正向词、`AND`、`OR`、`NOT`、引号短语与括号。过宽的 FTS 查询会明确要求收窄。
3. 点击「检查与预览」，查看最多 5 个样本，然后确认关联。重复提交同一范围得到同一引用。
4. 点击「进入探索」，检索、翻页或打开原文与讨论串。不同归档和附加筛选条件使用独立游标。详情分别显示原帖报告评论数和已归档评论数，并展示至多 15 条精选归档评论。包可能只保存精选评论或截断正文。
5. 回到数据接入可解除关联。归档文件与历史推流写入由其各自的生命周期管理。

定向排查时，未启用或未配置请查看环境变量，离线请查监听地址和私网连通性，凭证不匹配请检查两个进程的独立服务 token。无可用包、包损坏或文件路径越界请在插件节点执行 `inspect` 并核对 manifest、Parquet、FTS 文件和访问权限。归档版本变化后，在数据接入复核并确认新版本。忙碌、召回超限、临时文件额度或超时错误可通过重试或收窄范围处理。设置 `ARCHIVE_ANALYSIS_ENABLED=false` 并重启主线即可停用归档查询。

## 5. 兼容的旧版推流

管理员可从项目 R4 卡片的「高级操作」打开运维控制台。控制台保留 PowerShell/Bash 命令和既有 `inspect`、`query`、`push`、`--dry-run`、`--resume` 路径。先执行 dry-run，再根据需要用单独的受限机器密钥进行小批推流。`ingest` 收据中的 `batchId` 可在批次型项目的「数据批次」按既有权限显式关联。无需将这批内容再关联为离线归档引用。
