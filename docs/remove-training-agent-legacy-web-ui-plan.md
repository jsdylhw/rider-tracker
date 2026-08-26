# 删除 Training Agent 遗留 Web UI：实施方案

> 实施状态（2026-08-26）：本方案的旧能力对照、Rider Garmin 快捷入口、静态前端删除、
> legacy API 删除、测试替换、根 CI 合并、活动报告迁移和主要文档清理已在当前开发分支工作区完成；
> 尚待代码检视、浏览器手工验收和提交。

## 1. 目标

删除 `services/training-agent` 从旧 Personal FIT Agent 仓库迁入的独立浏览器界面，确立唯一产品入口：

```text
Browser -> Rider Node :8787 -> Python Backend :8000
```

完成后：

- 用户只访问 Rider 页面；
- Python Backend 不再渲染 HTML、CSS 或浏览器 JavaScript；
- Python 只提供 Rider 需要的内部 HTTP API 和 CLI；
- Garmin、FIT、Strava、路线和 Agent 的底层能力继续保留；
- 删除为旧页面独占的 HTTP 兼容层，不删除对应 application/operation 能力；
- Rider 当前 API、Agent schema、数据库 schema 和 CLI 行为保持不变。

本方案不同时处理 Python namespace、数据库迁移、路线 provider 或长任务异步化。

## 2. 为什么可以删除

### 2.1 当前存在两个浏览器入口

Rider 正式前端：

```text
index.html
src/ui/**
src/styles/**
src/server/**
```

Training Agent 遗留前端：

```text
services/training-agent/app/static/index.html
services/training-agent/app/static/app.js
services/training-agent/app/static/styles.css
```

遗留前端同时实现了：

- Garmin 同步；
- FIT 文件列表；
- 单活动分析；
- Markdown/图表 Presentation；
- Strava 上传；
- Agent 对话；
- 路线候选和 Strava 路段地图。

这些能力已经在 Rider 页面、Node API、Python Agent/CLI 中存在。继续维护第二套页面会导致：

- 同一 Presentation 需要两套 renderer；
- 同一路线候选需要两套交互测试；
- 同一 Strava 状态需要两套文案与轮询逻辑；
- Python `app/api.py` 同时承担内部 API 和静态站点职责；
- 用户可能绕过 Rider Node 的统一安全、文件和页面边界。

### 2.2 删除的是页面，不是 Python 能力

以下能力继续保留：

- `operations/activity/*`：同步、分析、上传和 Workflow；
- `services/activity/*`：导入、详情、历史和报告；
- `agent/*`：对话、Skill、Tool、Presentation；
- `integrations/*`：Garmin、Strava、LLM 和地图；
- `app/cli.py`、`app/debug_cli.py`；
- Rider 正在使用的 Python HTTP API。

删除旧 HTTP endpoint 也不等于删除其底层函数。例如删除
`POST /api/garmin/download` 后，`sync_garmin_activities_tool()` 仍被 Agent workflow 和 CLI 调用。

## 3. 当前 API 消费关系

### 3.1 Rider 必须保留的 Python API

| Python API | Rider 消费方 | 结论 |
|---|---|---|
| `GET /health` | `scripts/start-local.js`、Node health proxy | 保留 |
| `POST /api/chat` | Node `agent-routes.js` | 保留 |
| `POST /api/activities/ingest-fit` | Node activity ingestion | 保留 |
| `GET /api/activities/{id}/detail` | Rider activity detail | 保留 |
| `GET /api/athlete-profile` | Rider settings | 保留 |
| `PUT /api/athlete-profile` | Rider settings | 保留 |
| `GET /api/strava/config` | Node Strava routes | 保留 |
| `GET /api/strava/connection` | Node Strava routes | 保留 |
| `POST /api/strava/auth-url` | Node OAuth start | 保留 |
| `POST /api/strava/exchange-code` | Node OAuth callback | 保留 |
| `POST /api/strava/upload-activity` | Rider activity upload | 保留 |
| `GET /api/strava/upload-status/{id}` | Rider upload polling | 保留 |
| `POST /api/route-plans/select` | Rider AI route preview | 保留 |
| `POST /api/route-plans/command` | Rider route operations | 保留 |
| `POST /api/route-narrations/prepare` | Rider Street View narration | 保留 |

上述 URL 在双前端删除期间不得改名。

### 3.2 旧 Web UI 独占 API

| 旧 API | 旧页面用途 | 正式替代入口 | 计划 |
|---|---|---|---|
| `GET /api/dashboard/status` | 显示配置/FIT 数量 | Rider 页面和 Agent health | 删除 |
| `POST /api/garmin/connect` | 单独验证 Garmin | Agent workflow/CLI 实际同步结果 | 删除 |
| `POST /api/garmin/download` | 旧页面同步 | Agent `run-activity-workflow`、CLI | 删除 |
| `GET /api/fit-files` | 扫描目录生成列表 | SQLite activities + Rider 活动页 | 删除 |
| `POST /api/fit-files/analyze` | 按任意受管路径分析 | Agent 按 activity_id 分析 | 删除 |
| `GET /api/summary` | 返回 Markdown 报告 | activity detail/presentation | 删除 |
| `POST /api/strava/upload` | 旧 activity_key 上传 | `/api/strava/upload-activity` | 删除 |

仓库检索结果显示，这些 URL 除 `app/static/app.js`、`tests/test_api.py` 和文档外，
没有 Rider Node 或 Rider 浏览器调用方。

## 4. 精确删除清单

### 4.1 整体删除的文件

```text
services/training-agent/app/static/index.html
services/training-agent/app/static/app.js
services/training-agent/app/static/styles.css
services/training-agent/tests/test_web_ui.py
```

旧主视觉如果根产品不再使用，可在文档清理提交中删除：

```text
services/training-agent/figure.png
```

`figure.png` 不应和第一批页面删除强制捆绑，避免遗漏其他文档引用。

### 4.2 `app/api.py` 删除内容

静态站点：

- `FileResponse` import；
- `StaticFiles` import；
- `STATIC_DIR`；
- `app.mount("/static", ...)`；
- `GET /` 的旧 HTML response。

旧 request models：

- `DownloadGarminRequest`；
- `AnalyzeFitRequest`；
- `UploadStravaRequest`。

旧 endpoints：

- `dashboard_status_endpoint()`；
- `garmin_connect_endpoint()`；
- `garmin_download_endpoint()`；
- `fit_files_endpoint()`；
- `analyze_fit_endpoint()`；
- `summary_endpoint()`；
- `strava_upload_endpoint()`。

只为旧 endpoints 存在的 helpers：

- `_fit_output_dir()`；
- `_fit_files()`；
- `_fit_file_info()`；
- `_display_summary_from_analysis()`；
- `_display_summary_from_fit()`；
- `_activity_sort_key()`；
- `_parse_datetime()`；
- `_meters_to_km()`；
- `_seconds_to_min()`。

只为旧 endpoints/helpers 存在的 imports：

- `datetime`；
- `get_analysis_summary`、`summary_schema_version`；
- `analyze_fit_document`、`check_garmin_connection`、`sync_garmin_activities_tool`；
- `DEFAULT_OUTPUT_DIR`；
- `ActivityStore`、`file_content_key`；
- `upload_activity_to_strava`；
- `parse_activity_fit as parse_fit`。

实际修改时应由 lint/import 检查再次确认，不凭这张列表盲删。

### 4.3 必须保留的相似内容

- `Path`：`_require_managed_path()` 和 FIT ingestion 仍需要；
- `load_config()`、`cfg_get()`：API Token 和 Strava config 仍需要；
- `_require_api_access()`：所有内部 API 的安全边界；
- `_require_managed_path()`：Rider FIT ingestion 的文件边界；
- `upload_stored_activity_fit()`：Rider Strava 上传；
- `get_strava_upload_status()`：Rider 上传状态；
- `ChatSessionStore`：对话和路线 session；
- `project_presentations()`：路线 command 结果；
- 所有当前 Rider API request models。

## 5. 测试调整

### 5.1 删除旧 UI 测试

整体删除 `tests/test_web_ui.py`。它验证的是即将删除的：

- sessionStorage API Token；
- 旧页面 Strava 成功文案；
- 旧页面 Chat/Presentation renderer；
- Leaflet 候选切换；
- 旧页面双栏 CSS；
- 静态资源 cache-busting。

这些断言不能原样迁移成 Rider 测试，因为 Rider 已有自己的 renderer、路线和 Strava 测试。
旧页面中仍有产品价值的 Garmin 同步入口和已生成活动报告已分别迁入 Rider Agent 快捷入口与活动详情页；
报告正文复用统一安全 Markdown DOM renderer，不直接插入 `innerHTML`。

### 5.2 从 `tests/test_api.py` 删除的测试

- Dashboard Token 测试；
- `/api/fit-files/analyze` 受管路径测试；
- analyze history flag 测试；
- 旧 `/api/strava/upload` 委托测试；
- 旧 `/api/garmin/download` 委托测试。

其中“API Token 必须生效”和“FIT 不得读取任意路径”仍是有效安全规则，不能随着旧 endpoint
测试一起丢失。

### 5.3 新增或加强的替代测试

1. API Token 边界

现有 `test_chat_uses_existing_api_token_boundary` 已覆盖配置 Token 时的 401/200。
建议再给 `ingest-fit` 或 `athlete-profile` 增加一个非聊天 endpoint Token 测试，防止安全逻辑
只在对话路径上被验证。

2. FIT managed path

现有 ingestion 测试只覆盖合法路径。需要新增：

```text
POST /api/activities/ingest-fit
path = Rider data/files/fit 外部文件
-> 403
```

这样删除 `/api/fit-files/analyze` 后，目录穿越保护仍有回归测试。

3. 旧 API 不再公开

新增 OpenAPI/route contract 测试，断言以下路径不存在：

```text
/api/dashboard/status
/api/garmin/connect
/api/garmin/download
/api/fit-files
/api/fit-files/analyze
/api/summary
/api/strava/upload
```

同时断言 Rider 必需 API 仍存在。

4. 根路径行为

如果 `/` 改为 JSON，测试其只返回：

```json
{
  "service": "rider-training-backend",
  "status": "ok"
}
```

如果选择不提供 `/`，测试 404；不要再次返回 HTML。

5. Node 代理契约

保留并运行：

- `tests/unit/personal-fit-agent-client.test.js`；
- Agent routes 测试；
- Strava routes 测试；
- activity ingestion/detail 测试；
- route narration client 测试。

## 6. 文档调整

### 6.1 `services/training-agent/README.md`

删除或重写：

- `figure.png` 主视觉；
- “在 Web UI 中查看……”能力描述；
- “通过局域网访问 Web UI”的说明；
- 独立启动 Web UI 和打开 `127.0.0.1:8000` 的章节；
- 旧 `data/personal-fit-agent.db` 默认路径。

替换为：

- Rider 是唯一浏览器入口；
- `npm start` 是推荐启动方式；
- `npm run start:agent` 只用于后端诊断，不提供产品页面；
- CLI 是确定性维护入口；
- Python API 是 Rider Node 的内部接口。

### 6.2 `AGENT_STRUCTURE.md`

该文档已经声称 `/api/chat` 尚不存在，与当前代码冲突。双前端删除时至少应：

- 标记为历史文档，禁止继续作为当前架构依据；或
- 将有效 Agent 内部结构合并到根 docs 后删除。

不要只修改其中“Web UI”一段而保留其他明显过时结论。

### 6.3 根文档

需要同步：

- `docs/training-agent-integration.md`：明确 Python `/` 不再提供 UI；
- `docs/rider-final-architecture-and-python-migration.md`：记录该清理在完整迁移中的阶段位置；
- 根 `README.md`：一般无需改功能描述，只需确认没有引导访问 Python 端口。

## 7. 推荐提交拆分

### Commit 1：删除静态站点

范围：

- 删除 `app/static/*`；
- 删除 `tests/test_web_ui.py`；
- 删除 FastAPI 静态挂载；
- `/` 改为服务状态 JSON 或 404；
- 暂时保留旧 API。

目的：先让产品只剩一个前端，不同时扩大 API 删除风险。

验收：

- Python `/static/*` 返回 404；
- Python `/` 不返回 HTML；
- Rider 首页、活动、路线和 Strava 页面正常；
- `npm test`、`npm run test:agent`、`npm run test:integration` 通过。

### Commit 2：删除旧 UI 独占 API

范围：

- 删除 7 个 legacy endpoints；
- 删除 3 个 request models；
- 删除旧 helper/import；
- 清理 `tests/test_api.py`；
- 新增 current API allowlist/legacy denylist 测试；
- 新增 ingestion 外部路径拒绝测试。

目的：缩小 Python HTTP surface，不删除底层业务能力。

验收：

- Rider 所有当前 API contract 测试通过；
- 旧 endpoint 均为 404；
- Agent Garmin workflow 和 CLI Garmin sync 仍通过；
- Rider Strava 上传仍通过 `/upload-activity`；
- FIT 导入和详情不受影响。

### Commit 3：文档和遗留资产

范围：

- 重写内嵌 service README；
- 处理 `AGENT_STRUCTURE.md`；
- 更新 integration 文档；
- 确认引用后删除 `figure.png`；
- 删除子目录 `.github/workflows/test.yml`，或把仍需要的 CI 检查迁入根 workflow。

目的：避免代码删除后，文档仍引导用户访问旧页面。

### Commit 4：拆分 FastAPI routers（可选，后续）

双前端删除稳定后再把 `app/api.py` 按资源拆分。该提交不能改变 URL、response 或安全依赖。

```text
app/api/
├── main.py
├── dependencies.py
├── models.py
└── routes/
    ├── agent.py
    ├── activities.py
    ├── athlete.py
    ├── strava.py
    ├── route_plans.py
    └── narration.py
```

## 8. 实施前检查

执行删除前固定当前消费面：

```bash
pwd
git branch --show-current
git status --short
rg -n '/api/dashboard/status|/api/garmin/connect|/api/garmin/download|/api/fit-files|/api/summary|/api/strava/upload' \
  src scripts tests README.md docs services/training-agent \
  --glob '!services/training-agent/app/static/**'
```

检查本地是否有人直接依赖旧 Python 页面。它不影响正式架构判断，但决定是否需要在删除前给出一次
迁移提示。

## 9. 自动验收

每个 commit 至少运行：

```bash
git diff --check
npm test
npm run test:agent
npm run test:integration
npm run db:check
```

定向测试：

```bash
cd services/training-agent
python -m pytest -q tests/test_api.py
python -m pytest -q tests/test_architecture.py
python -m pytest -q \
  tests/test_activity_ingestion.py \
  tests/test_activity_workflow_service.py \
  tests/test_strava_duplicate.py
```

静态确认：

```bash
test ! -d services/training-agent/app/static
test ! -f services/training-agent/tests/test_web_ui.py
rg -n 'StaticFiles|FileResponse|STATIC_DIR' services/training-agent/app
rg -n '@app\.(get|post)\("/api/(dashboard|garmin|fit-files|summary)|@app\.post\("/api/strava/upload"' \
  services/training-agent/app
```

## 10. 浏览器手工验收

使用 `npm start`，只从 Rider `http://localhost:8787` 操作：

1. 首页 Agent 能发送消息和恢复 session；
2. 同步活动后 Rider 活动列表更新；
3. 打开活动详情，曲线和报告正常；
4. 导入 FIT 后生成活动；
5. AI 路线能生成、选择、修改、确认和保存；
6. Strava 能授权、上传和轮询结果；
7. 街景路线讲解能请求和展示；
8. 直接访问 Python `/static/app.js` 返回 404；
9. 直接访问 Python `/` 不出现旧页面。

## 11. 回滚策略

该改动不迁移数据库和用户文件，回滚主要是代码回滚：

- Commit 1 可独立恢复静态页面；
- Commit 2 可独立恢复 legacy API；
- Rider 正式 API 始终保持不变；
- 不删除 Garmin、Strava、FIT 或 Agent application service；
- 不修改 schema version 和数据库 `user_version`。

如果发现外部脚本仍调用旧 API，应先确认它是否属于 Rider 正式产品。确需短期兼容时，可以保留
API 并返回 deprecation header，但不能恢复第二套静态前端。

## 12. 完成标准

双前端清理完成必须同时满足：

- 仓库只有 Rider 一套浏览器 UI；
- Python Backend 不包含产品 HTML/CSS/浏览器 JS；
- Rider 所需 Python API 全部保留且有 contract test；
- 旧 UI 独占 API 不再公开；
- Garmin/分析/Strava 底层能力仍可从 Agent workflow 和 CLI 调用；
- 文档不再引导用户访问 `127.0.0.1:8000` 页面；
- 全量 Node、Python 和双进程集成测试通过；
- 无数据库、Token、FIT 或 workflow 数据迁移。
