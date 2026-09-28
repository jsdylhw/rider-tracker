# Python 入口发布与回退

当前 `npm start` 已按用户决定切换为 Node 包装 Python 统一启动器，浏览器直接访问 Python，默认公共端口 8787。旧 Node BFF 保留为 `npm run start:legacy`。这是可回退的默认入口切换，真实骑行和兼容观察尚未完成，不代表满足删除旧入口的全部门槛。

## 构建

在已经安装前端依赖的开发目录执行：

```bash
python scripts/build-rider-release.py --output dist/rider-python-preview
```

输出目录必须不存在。产物包含同一份页面、公开 JS/CSS、FIT SDK、Python 后端、Skill Markdown、数据库预检与启动脚本、示例配置和运行说明。不会复制实际 config.yaml、.env、数据库、FIT、Token 或日志；不包含 Node server 或 node_modules。release-manifest.json 是文件 SHA-256 清单，不是签名。

## 安装与运行

进入产物根目录，使用已激活的 Python 3.12+ 环境。可以使用 Conda，不会自动新建或替换环境。

```bash
python -m pip install -e services/training-agent
python scripts/start-rider.py
```

首次使用时按 config.yaml.example 创建自己的 config.yaml。预览默认监听 127.0.0.1:8000；实际端口遵循统一配置，可用 --port 覆盖。设置数据根目录时使用绝对路径，以便不同发布目录指向同一数据。不要同时启动多个处理同一端口的入口。

已有环境且依赖满足时不必重新安装。Linux x86_64 / Python 3.13 的已验证环境另提供版本约束：

```bash
python -m pip install -c services/training-agent/constraints/linux-x86_64-py313.txt -e "services/training-agent[test]"
```

该约束包含运行、构建和测试依赖，来自通过测试的环境闭包，未冻结其他 Conda 包。它只固定版本，没有 wheel 哈希；不能当作 Windows 或 Python 3.12 的验证结果。源码中的 lock-backend-dependencies.py --check 可检查已安装版本及 pyproject 指纹；生成器不会下载或安装包。

启动前运行既有数据库 ensure；需要升级时按既有迁移工具先备份。启动器管理 Web、私有 Agent 执行进程及既有 Worker。Agent 仅监听本机临时端口，以每次启动生成的内部令牌认证；模型循环和工具不变。Agent 首次就绪检查最多等待约 5 秒，失败后仍启动基础 Web。

Agent 或 Worker 退出会提示相关功能不可用，页面和普通 API 保持。传输不会自动重试或重放修改请求，连接中断后应先检查已有结果。Ctrl+C 停止该启动器拥有的进程。--without-worker 启动 Web 与 Agent，--worker-only 单独启动 Worker。

## 切换与回退演练

1. 保留当前源码、Python 环境与可工作的 Node 入口。记录正在使用的绝对数据库/文件路径，不复制凭据到发布产物。
2. 退出旧启动器，确认端口释放，再启动 Python 入口。OAuth redirect URI 必须指向当前入口；不能在两个入口间接力一个授权回调。
3. 检查活动、FIT 详情、路线、会话与任务状态；切换不会清除数据，也不会恢复进程内的浏览器会话或 OAuth state。
4. 回退时退出 Python 启动器，在原源码目录执行 npm run start:legacy，使用同一套数据路径。重新打开页面；若正在授权，重新发起授权。
5. 本次无额外数据库 schema 变更，不需要倒退 schema 或还原备份。未来版本若有 schema 变更，应使用其专门回退说明，不能套用本步骤。

HTTP 集成测试使用临时数据执行同端口 Python → Node → Python，检查活动/路线/会话读取及回退期间的档案写入保留。该证据不替代真实账号 OAuth、浏览器设备操作、Windows 或长期兼容观察。

## 实际浏览器冒烟

已安装 Chromium/Edge 时，可运行 `python scripts/test-python-browser-ui.py --browser <浏览器可执行文件>`。此可选测试不下载浏览器，使用临时数据库、配置、静态资源副本和独立浏览器 profile；通过页面实际控件验证会话选择、删除确认/取消、新建，并验证 Cookie 认证、SDK 加载与无地图配置时的降级。WSL 可指定 Windows Edge 的 exe 路径，结束后清理其临时 profile。

已在 Windows Edge + WSL Python Web 上通过。它不能证明 Windows Python 后端启动已通过，也不覆盖真实 OAuth、模型、地图或蓝牙设备。

## 尚未通过的最终切换门槛

独立 Python 启动器已隔离 Web 与 Agent；直接 app.browser:app 未配置私有 Agent URL 时仍为兼容的同进程模式。已有 Worker 只承接部分任务，Agent 同步执行尚未任务化。完整浏览器/设备及真实 OAuth、Windows 干净环境完整业务验收和兼容观察期仍未完成。Windows 原生生命周期已用隔离产物验证。按冻结架构保留 Node 兼容入口，不删除旧服务，也不将流式进度显示或进程隔离作为持久恢复证据。


## Windows 原生补验与依赖条件

已使用 Windows Conda Python 3.13.9、FastAPI 0.138.1 / Starlette 1.3.1 验证搬移后的发布目录：HTML、Cookie、目录/会话 API、SDK、multipart 非法 FIT 拒绝、Worker 注册，以及 CTRL_BREAK 后 Web/Agent/Worker 全部退出。原 Conda 缺少 multipart，测试仅将已安装的纯 Python 包放到临时 PYTHONPATH；未安装或修改原环境，也没有下载包。该目录已经清理，不能将它视为已给用户安装好依赖。

原生验证修复了两个 Linux 环境未暴露的问题：较新 FastAPI 的嵌套路由需在 include 前筛选；Windows 静态路径的内部反斜杠需要和 URL 中的非法反斜杠区分。当前 Linux 版本约束不适用于直接锁定 Windows 依赖。

官方开发安装使用 `npm run setup:agent`，现在选择 pyproject 的 test extra，包含 pytest 和 wheel 构建工具。已有 Conda 可选择 `python -m pip install -e "services/training-agent[test]"`；只运行产品时仍使用不带 test 的安装命令。不会因运行启动器自动安装任何包。

普通 Browser API 请求上限为 10 MiB，包括没有 Content-Length 的分块请求；FIT multipart 保留单文件 32 MiB、总请求 33 MiB 的独立边界。

## 剩余人工验收记录

下列项目尚未全部完成；已取得的部分证据分别记录。执行时记录发布产物 manifest 的哈希、系统/Python 版本、入口、开始和结束时间及结果；不要记录 Token、授权 code、Cookie 或用户 FIT 内容。保留失败项，不能以其他测试通过替代。

| 项目 | 操作与通过条件 | 当前缺少的证据 |
| --- | --- | --- |
| 真实 Strava 授权 | 在 Python 入口发起授权，用户登录确认后返回同一入口；页面显示连接成功，重新加载仍可读取连接状态；取消授权显示可理解的结果 | 用户登录授权后的实际结果；隔离回调测试不覆盖提供商和浏览器联动 |
| Windows 干净安装 | 新建临时 Python 环境，按本说明安装独立产物；执行 pip check，启动后验证首页、SDK、FIT 导入和停止释放端口 | 已通过独立 venv 安装、pip check、首页/SDK/会话、FIT 导入及停止；详细范围见下方补验记录 |
| 浏览器与设备 | 在 Python 入口完成设备连接、开始/结束一次骑行、保存 FIT 和活动详情读取；检查讲解及路线预览 | 真实设备和完整骑行记录；HTTP 与无设备浏览器测试不覆盖此链路 |
| 兼容观察 | 用户开始试用时确定观察起止及常用业务范围，期间记录 FIT、路线、会话、讲解和账号功能的结果，包含重启后读取已有数据；结束时逐项复核并保留异常 | 尚未开始有明确范围的日常试用；不能把进程空跑或一次回归算作观察周期 |

正式切换前还需复核冻结架构的全部门槛及数据库升级/备份证据，以上清单不是对门槛的缩减。现在默认使用 Python 公共入口；授权或观察期间发现异常时，先记录已有业务结果，再依照回退步骤退出 Python 入口并回到 npm run start:legacy，避免重复执行外部操作。

## Windows 干净环境安装补验

2026-09-28 使用原生 Windows Python 3.13.9 创建不继承 site-packages 的临时 venv，对独立发布目录执行不带 test extra 的正式安装命令。依赖下载、editable 构建和 pip check 成功；实际解析到 FastAPI 0.141.1、Starlette 1.7.0、python-multipart 0.0.32。没有使用此前的 multipart 覆盖目录，也未修改原 Conda 环境。

该环境通过首页、Cookie、活动/路线目录、私有 Agent 会话创建、SDK 及 CTRL_BREAK 后端口释放。临时产物、数据和 venv 已清理。本次没有运行 FIT 导入、真实账号、模型、地图或设备测试，因此只补齐干净安装与基础启动证据，不宣布全部 Windows 业务验收完成。下载曾发生一次 SSL EOF，pip 重试成功，不属于应用执行失败。

随后在另一个不继承已有包的 Windows 临时 venv 补验生成 FIT：导入、重复导入身份/文件引用稳定、补传、beacon 保存、活动详情 records 读取，以及非法 FIT 返回 400 并保留原活动引用与 records，均通过。本次仍使用正式安装命令，pip check 通过，停止后端口释放，临时环境已清理。该证据补齐上文的干净环境 FIT 缺口，不替代真实设备骑行或账号操作。

## 默认入口切换与端口

`npm start` → `scripts/start-python.js` → `scripts/start-rider.py --public-entry`，Node 仅负责选择 Python、转发输出和打开浏览器。Python 管理 Web、私有 Agent 和 Worker，读取统一配置。公共入口遵循 `HOST`/`PORT` 或 `rider.host/port`，默认 127.0.0.1:8787；`npm start -- --port 9000` 可临时覆盖。直接 Python 使用 `--public-entry` 得到相同行为，不带该选项仍保留原预览端口选择。

Ctrl+C 关闭启动器；Node 退出时控制管道 EOF 通知 Python 清理伴随进程，不在 Windows 上用强制终止代替正常退出。切换前退出旧进程，不同时占用公共端口。Strava 登录已由用户反馈通过，但当时具体入口未经确认，仍不能据此声明新默认入口的所有账号及骑行链路验收完成。
