> 默认入口已按用户决定切到 `npm start` → Python 公共入口 :8787；`npm run start:legacy` 回退。下面分阶段记录中的默认 Node 是当时状态，不代表当前入口。真实骑行及兼容观察仍待完成，未删除旧服务。

# Python 浏览器入口迁移清单

更新：2026-09-28。依据当前代码及 `tests/contracts/rider-browser-http-api.v1.json`，不是冻结架构文档的替代品。

## 工作评估与当前交付

当前交付是阶段 7B 静态页面、上传及 Browser API 适配，不是阶段 8 默认入口切换。默认 `npm start` 仍使用 Node :8787；`app.api:app` 的根路径继续返回后端元数据。

| 工作 | 本轮结果/后续范围 |
| --- | --- |
| 1. 核对 Browser API surface | 下表覆盖基线全部方法和路径；区分同路径实现、参数/响应待对照、尚缺边缘适配 |
| 2. Python 托管同一页面 | 新增可选 `app.browser:app`；复用同一 HTML、JS、CSS、FIT SDK 资源和现有 API |
| 3. 上传 | 已接入 Python multipart 接收、受管落盘、失败清理和重复提交；Node 仅转发，复用 FIT ingestion |
| 4. OAuth 与其他 Browser API 适配 | 已补 Strava、Agent、活动/路线/讲解的 Browser 适配和本机会话；真实授权、全表失败分支仍待验收 |
| 5. 切换默认入口 | 全表响应级对照、安全/降级验收及发布检查之后再评估 |

静态入口规模较小，新增独立入口与静态策略、启动选项和回归即可；主要剩余风险在 OAuth 和剩余浏览器 API 适配。阶段 6 中尚未任务化的长操作仍单独评估，不在本轮强制迁移。

## Browser API 对照

“同路径实现”仅表示 Python 存在相应路由，不等于响应、安全、错误、流式行为已与 Node 全面对照。参数名差异在清单生成时已归一化。API 本轮不增加跨进程反向代理。

| 方法 | 浏览器路径 | Python 当前状态 |
| --- | --- | --- |
| POST | `/api/jobs` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/jobs/capabilities` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/jobs/{jobId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/jobs/{jobId}/cancel` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/jobs/{jobId}/report-rebuild` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/` | 本轮可选入口完成；默认后端仍为元数据 |
| GET | `/healthz` | 7A 已对照；本轮复用 |
| GET | `/api/runtime-config/maps` | 7A 已对照；本轮复用 |
| GET | `/strava/login` | Python 预览入口已实现；隔离授权测试通过，真实账号待验收 |
| GET | `/api/user-profile` | 7A 已对照；本轮复用 |
| PUT | `/api/user-profile` | 7A 已对照；本轮复用 |
| GET | `/api/activities` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/activities/rider-session` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/activities/fit-import` | 已迁入 Python；Node 转发 multipart，实际 HTTP 对照通过 |
| POST | `/api/activities/fit-beacon` | 已迁入 Python；Node 转发 multipart，实际 HTTP 对照通过 |
| GET | `/api/activities/{activityId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| PATCH | `/api/activities/{activityId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| DELETE | `/api/activities/{activityId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/activities/{activityId}/fit` | 已迁入 Python；Node 转发 multipart，实际 HTTP 对照通过 |
| GET | `/api/routes` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/routes` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/routes/{routeId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| PATCH | `/api/routes/{routeId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| DELETE | `/api/routes/{routeId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| PUT | `/api/routes/{routeId}/progress` | 同路径实现；完整响应级对照仍待迁移验收 |
| DELETE | `/api/routes/{routeId}/progress` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/agent/health` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| POST | `/api/agent/chat` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| GET | `/api/agent/sessions` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| POST | `/api/agent/sessions` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| GET | `/api/agent/sessions/{id}` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| DELETE | `/api/agent/sessions/{id}` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| POST | `/api/agent/route-plans/select` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| POST | `/api/agent/route-plans/command` | 已适配 Browser URL；会话生命周期、参数、JSON/NDJSON 隔离测试通过 |
| POST | `/api/route-narrations/prepare` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/route-narrations/jobs/{jobId}` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/route-narrations/photo` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/strava/config` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/strava/config` | Python 预览入口已补 409 拒绝响应；与 Node HTTP 对照通过 |
| GET | `/api/strava/auth/start` | Python 预览入口已实现；隔离授权测试通过，真实账号待验收 |
| GET | `/api/strava/auth/callback` | Python 预览入口已实现；隔离授权测试通过，真实账号待验收 |
| GET | `/api/strava/connection` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/strava/routes` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/strava/routes/refresh` | 同路径实现；完整响应级对照仍待迁移验收 |
| GET | `/api/strava/routes/{routeId}/gpx` | 同路径实现；完整响应级对照仍待迁移验收 |
| POST | `/api/strava/upload-fit` | Python 预览入口已补 410 退役响应；与 Node HTTP 对照通过 |
| POST | `/api/strava/upload-activity-fit` | 预览入口已适配现有 upload-activity 业务；参数/响应隔离测试通过，未真实发布 |
| GET | `/api/strava/upload-status/{uploadId}` | 同路径实现；完整响应级对照仍待迁移验收 |

## 静态入口的边界与操作

运行 `npm run start:browser-preview`，默认访问 `http://127.0.0.1:8000/`。该命令复用现有数据库预检、配置和 Worker 启动编排，不启动 Node BFF；启动器仍需要 Node。不要与占用同一 Python 端口的 `npm start` 同时运行。退出后运行原 `npm start` 即回到默认入口，没有修改配置或端口。

安装依赖方式不变：先按仓库说明准备 Python 环境和 `npm install`。FIT SDK 资源缺失时返回 404，不导致页面进程无法启动。基线 48 项路径均已存在；这不代表所有响应分支和真实浏览器操作已经等价验收。Strava 真实授权及故障隔离门槛仍待验收，暂不替换正式入口。

- 仅 `/` 返回项目同一份 `index.html`，不维护第二套页面。不启用任意路径的 SPA fallback；未知 API/资源和旧 `/static/app.js` 返回 404。
- `/src` 仅开放浏览器目录及 `style.css`；`src/server`、隐藏文件、Python、配置、数据和任意目录不公开。拒绝路径穿越、反斜杠和符号链接。
- `/vendor/@garmin/fitsdk` 只提供前端所需 JS 文件，不开放整个 node_modules。
- 资源固定 MIME，并设置 nosniff；未带内容哈希的资源使用 `Cache-Control: no-cache`，通过 ETag/Last-Modified 重新验证，支持 HEAD/304。
- 源码资源根目录由入口文件位置确定，与可变数据根目录分离；测试不会读取用户配置、凭据或数据来构造静态目录。
- 复用 Python 现有 API 中间件和异常处理。API 的 Host/Origin/token 策略不因静态入口新增而放宽。

验收包含真实前端文件字节、JS/CSS MIME、缓存与 HEAD、私有路径/符号链接拒绝、缺 SDK，以及临时数据库下 Node/Python 两入口实际 HTTP 资源对照。不等价于真实浏览器蓝牙、骑行设备或外部账号全业务验收。

本轮验证结果：Python 定向 83 项、JavaScript 453 项通过；正常与降级集成通过，Node/Python 实际 HTTP 资源对照通过；compileall、Node syntax、git diff --check 通过。清单已检查覆盖基线全部 48 项。尚未做真实浏览器视觉及设备验收。

## multipart 上传切片

三个现有 POST URL 保持不变：`/api/activities/fit-import`、`/api/activities/{activityId}/fit`、`/api/activities/fit-beacon`。Node 只接收并转发 multipart，不生成活动 ID、不保存 FIT、不归档会话。Python 接收文件后调用既有 ingestion 事务，统一拥有受管文件、活动、确定性分析与路线关联。

- Python 环境新增 `python-multipart>=0.0.20,<1`；推荐运行 `npm run setup:agent` 更新官方虚拟环境；手动管理环境时可使用 `python -m pip install -r services/training-agent/requirements.txt`。默认启动继续使用 `npm start`。
- 单个 FIT 最大 32 MiB；Python 总请求体限制 33 MiB，并对没有 Content-Length 的分块上传累计计数。仍是有界缓冲上传，不是无限大文件流式传输。
- 上传文件名只作为显示名称，落盘使用 Python 生成的唯一名称；不接受浏览器指定服务器文件路径。沿用 `FIT_FILE_DIR` / runtime_paths。
- 补传使用新文件，解析或事务失败不会覆盖旧 FIT。失败文件在确认未被数据库引用后清理；数据库状态无法确认时保留文件，避免误删已提交内容。
- beacon 先验证 FIT，再在同一个事务保存会话材料、活动、分析产物和路线关联，不再先创建半条活动。
- 同内容导入维持 `fit-<内容哈希>` ID；顺序重复上传复用当前文件。替换成功后的旧文件、进程崩溃留下的文件，以及并发重复上传的孤立文件，暂不自动回收。
- 非法 session JSON/非对象返回 400；缺文件、损坏 FIT、未知活动、数据库忙、大小超限分别有失败响应。Host/Origin/token 规则保持有效。
- 活动详情格式转换迁入 Python `rider_view.py`；Node 通过既有 detail URL 的 `view=rider` 获取页面形态。canonical detail 默认响应不变；旧 JavaScript 转换只保留在测试夹具用于迁移对照，生产不再调用。

验证覆盖临时数据库下真实 FIT 编码/解析和两个 HTTP 入口：导入、补传、beacon、重复提交、路线关联、旧格式对照、坏文件保留；定向测试补充缺参数、非法会话、大小限制、chunked 请求、权限和数据库忙。未调用地图、模型或外部账号；不代表清单其余 API 已完成等价迁移。

本切片最终验证：Python 定向 106 项、JavaScript 454 项通过，正常/降级 HTTP 集成通过，compileall、语法和 diff 检查通过。一次降级运行触发既有 health 3 秒超时阈值，重新运行通过，未放宽阈值。尚未做真实浏览器交互及设备验收。

安装回归：`npm run test:agent-setup` 创建不继承现有包的临时虚拟环境，通过官方 `setup-agent.js` 执行 `pip install -e . pytest`，随后运行 `pip check` 与三个 multipart 上传入口的定向测试。该测试需要联网下载依赖，独立于确定性 `test:all`；临时环境结束后清理。运行时依赖清单的一致性由架构测试检查。

官方安装补验结果：全新临时环境执行 `npm run test:agent-setup` 成功，自动安装 multipart，pip check 无冲突，三个上传入口的 14 项测试通过；现有环境上传/架构 26 项、JavaScript 454 项通过。临时环境已清理，未更改现有 Conda 环境。


## 历史切片：非 Agent 范围的 Strava 浏览器适配

按当前用户范围，暂停 Agent 对话入口适配、长任务接入 Worker、恢复和工具调用改造。本轮只新增 `app/strava_browser.py`，挂载到可选 `app.browser:app`；默认 Node 入口及内部 `app.api` 路径/响应保持原状。已补授权页面、授权开始、回调与结果页，以及 config、connection、upload-status 的浏览器字段和两个上传兼容 URL。页面是 Python HTML 实现，尚未进行视觉等价验收。

- 授权 state 有效期 10 分钟、一次性使用，并与 HttpOnly / SameSite=Lax Cookie 绑定。HTTPS 时设置 Secure。授权窗口属于启动它的入口；Python 预览不能把回调交给 Node 的状态存储，回调 host/port 不一致会明确拒绝。
- state 仅在当前进程内，重启后应重新授权；这不是持久化任务恢复。Node 在过渡期仍保留其原有授权实现，不宣称本轮已经完成边缘 owner 全量切换。
- 未授权、过期、跨浏览器回调、重复回调和 scope 不足不会执行令牌交换。交换失败后不自动重放授权码。结果 HTML 转义用户内容，返回页面不包含访问令牌。
- 保留原 API Host/Origin/token 检查。OAuth callback 使用经校验的 state+Cookie 授权；授权开始仍需要原 API 访问权限。启用 web_api_token 时，Python 直接浏览器访问的完整认证体验仍是入口等价前的待办，未增加把服务端 Token 暴露给浏览器的绕过。
- Strava 路线列表/刷新等其余响应适配、真实账号授权/上传以及整页浏览器验收仍未完成。暂不切换 :8787，也不删除 Node。

本切片验证：Python 定向 109 项、JavaScript 454 项通过；实际 HTTP 比较两入口的登录页面可用性、无效回调拒绝、配置写入 409 和退役上传 410，同时回归静态资源和 FIT 上传。成功授权、Cookie 绑定、过期/重放、权限不足、交换失败、上传参数和跳转使用隔离 Provider 测试；未操作真实账号、模型或地图。compileall、Node syntax、git diff --check 通过。


## 后端融合目标下的后续进展

用户将目标明确为 Rider 整体融合后，本轮继续完成 HTTP 边缘适配。上节暂停范围中的 Agent URL 适配已解除；模型循环、工具选择、路线算法和恢复工作流仍保持不变。

- Agent：补八个 Browser URL，统一参数校验、会话操作、JSON 和 NDJSON 响应；工具与模型仍调用原业务。
- 活动与路线：Browser envelope、创建 201、sportType 参数以及 FIT 活动详情投影。讲解请求补样点 ID、距离裁剪、默认参数与任务 envelope。Strava 补路线目录、刷新和 GPX 转发。
- 本机认证：本机打开页面后取得 HttpOnly、SameSite=Strict 的短期会话；HTTPS 使用 Secure。页面不接触 API Token。重启会话失效；远程来源、伪造 Cookie、跨站请求不能获得权限，内部 API 不接受这个会话。
- 独立启动：在已安装依赖的 Conda/虚拟环境运行 `python scripts/start-rider.py`，默认 Python 浏览器端口 8000，加上现有 Worker；复用数据库预检。支持 `--host`、`--port`、`--worker-only`、`--without-worker`、`--assets`。使用当前 Python，不自动切换或下载环境；退出时等待子进程结束。
- 配置：Python 读取根 YAML 与 .env，显式环境变量优先；`RIDER_CONFIG_PATH`、`RIDER_ENV_PATH` 可指定文件。Node 旧映射在过渡期保留，由合约对照约束，尚未完成删除兼容实现。
- 静态资源：`python scripts/build-browser-assets.py --output dist/browser-release` 导出公开资源和 FIT SDK；输出目录必须不存在，避免覆盖其他发布。然后 `python scripts/start-rider.py --assets dist/browser-release`。运行不再依赖 node_modules，构建前仍需安装 SDK。资源 manifest 记录文件哈希，不公开配置或数据。

仍未完成：依赖版本锁定、所有异常响应与浏览器交互验收、真实 OAuth、Windows 生命周期验收，以及冻结架构中的 Agent/Web 隔离门槛。默认 `npm start` 与 :8787 保持原状；退出 Python 入口再执行原命令即可回退，无需数据格式转换。发布资源只是前端产物，尚不是完整独立后端安装包。


## 发布与回退补验

增加完整源码发布导出和运行说明，见 [发布与回退](python-release-runbook.md)。实际将产物放到临时目录后，以产物自己的启动器启动 Web/Worker，验证页面、SDK、带会话的 API、Worker 注册和端口释放；产物没有 Node server 或 node_modules。wheel 在离开源码目录后加载全部 Skill Markdown 的测试通过。

版本约束只覆盖当前 Linux x86_64 / Python 3.13 环境；闭包校验和 pip 离线 dry-run 通过，没有改动 Conda 或下载包。不能外推到 Windows 或另一 Python 小版本。

Worker 故障注入验证普通 API 继续可用。HTTP 集成完成同端口 Python→Node→Python 回退，目录、会话和档案写入保留。集成脚本新增显式隔离 YAML、.env 和凭据路径，避免加载开发者配置。上述验收仍不等于真实浏览器、设备或第三方 OAuth 验收。


## 独立启动器的执行隔离

`python scripts/start-rider.py` 现在启动 Web + 私有 Agent + 既有 Worker。私有 HTTP 进程承接八个 Agent Browser URL，Web 保留基础业务；内部令牌每次启动生成。Web 关闭原始执行 URL 别名，代理不重放请求。Agent 被终止后的基础 API 存活、NDJSON 提前断开和一次调用边界已验证。

直接 `app.browser:app` 或旧 npm 预览未设置私有 Agent URL 时仍为同进程兼容模式。不得用这种模式的测试证明独立进程故障隔离；实际隔离由启动器子进程故障测试和增强 HTTP 集成验证。真正的 Agent 任务化与恢复不在此切片中。


## Windows 与最终边界补验

Windows 原生发布目录的页面、Cookie、业务目录、私有 Agent 会话、SDK、multipart 和进程退出已通过；修正了新 FastAPI 嵌套路由过滤以及 Windows 内部静态路径分隔符兼容。使用已有 Conda 与临时 multipart 依赖，不代表已给用户安装好依赖或完成干净环境安装。

普通 API 请求统一限制 10 MiB，FIT multipart 保持独立限额。官方开发安装改为 pyproject 的 test extra；requirements 与运行/测试依赖一致。完整回归及后续边界回归通过，具体数字和范围见 ADR 尾部。真实 OAuth、账号流程和兼容观察仍待验收，不因自动测试通过切换默认入口。
