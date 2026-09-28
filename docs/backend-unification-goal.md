> 当前入口更新：用户已明确要求直接切换。`npm start` 现在启动 Python 公共入口，旧 Node 以 `npm run start:legacy` 保留。以下早期切片中的“默认不变”是历史状态；目标尚未全部验收，未删除旧入口。用户已反馈 Strava 登录通过，但未注明入口，不能替代新默认入口的全部账号验收。

# Rider 后端融合交付目标

## 目标与范围

将 `services/training-agent` 作为 Rider 内部后端交付：一个产品页面、一套 Browser API、一套人工配置和数据归属，以及可复现的安装启动方式。目录更名不是验收标准。

本轮可迁移 Agent 的 HTTP 路径、参数和响应适配，但不改模型循环、工具选择、路线算法或新增恢复/Worker 工作流。现有数据和业务行为必须保留；不擅自提交、推送或删除旧入口。

## 实施顺序

1. 补齐 `/api/agent/*` 浏览器适配及活动、路线、讲解的参数/响应差异。
2. 收尾浏览器认证和 OAuth，保留内部 API Token 边界，不将服务端密钥注入页面。
3. 统一配置解析、数据路径、数据库预检和 API/Worker 启动停止，明确 Conda 与官方环境安装方式。
4. 固定 Python 依赖并准备前端生产资源，避免发布运行依赖源码仓库的 node_modules。
5. 对照两个入口进行完整业务、安全与降级验收，记录发布、兼容观察和回退步骤。
6. 依据冻结架构检查切换门槛；达到门槛才切换默认入口。Agent 隔离等延期项不能用流式进度或文档声明代替。

## 当前进度

- 已有：Python 持久化 owner、统一数据配置入口、静态预览、FIT 上传与详情投影、官方安装缺依赖修复、Strava 预览适配。
- 已补齐：Agent 八个 Browser URL、活动/路线/讲解/Strava 响应适配、本机 HttpOnly 浏览器会话。保持既有业务实现，未改 Agent 循环。
- 已增加：使用当前 Python 环境的独立启动器、临时数据库启动/停止测试、公开静态资源导出和独立资源目录。
- 已补充：完整源码发布导出、搬离仓库后无 Node 启动、wheel Skill 资源声明、Worker 退出后的 Web 存活、同端口 Python→Node→Python 数据回退演练。
- 依赖：提供当前 Linux x86_64 / Python 3.13 的版本约束与离线一致性检查；未将此声明为跨平台锁或带哈希的供应链验证。
- 已补验：16 组实际 HTTP 失败状态/响应封装及 NDJSON 终止错误，两入口一致；独立 Windows Edge 的初始化、Cookie 认证、会话选择/删除/新建、SDK 和地图缺配置降级通过。
- 已隔离：Python 独立启动器将 Agent HTTP 执行放到私有进程，浏览器 Web 保留基础业务；每次启动生成内部令牌，关闭 Web 的内部执行别名，异常不自动重放。Agent/Worker 退出后基础接口存活已验证。
- 等待外部验收：真实账号、设备及日常兼容观察。模型循环、工具、路线算法和持久任务保持原样；Node 配置映射仍作为过渡实现，与 Python 映射进行隔离对照。
- 已补验：Windows 原生 Python 发布目录启动、Cookie/API/SDK、multipart 拒绝、Worker 注册与三个子进程退出；未修改 Windows Conda，缺少的纯 Python multipart 使用临时依赖目录。
- 未完成：真实 OAuth/账号流程及兼容观察；Windows 干净环境安装、基础启动及生成 FIT 的导入/补传/beacon/详情/失败保留已通过。Agent 仍是同步执行，不能把进程隔离当作任务化或新增恢复。
- 当前：npm start 包装 Python Web :8787 / Agent / Worker；start:legacy 保留旧 Node 入口，业务实现不变。

实际切片和测试结果记入 ADR；本文件不替代冻结架构，也不把未提交工作视为已发布。


## 切换门槛审计

对应冻结架构第 14 节；下表记录证据，不改变门槛，也不意味着现在允许删除 Node。

| 门槛 | 当前证据与结论 |
| --- | --- |
| 1. Node 不再拥有 SQLite/后台业务 | 现有 Python repository/Worker owner；Node 保留边缘兼容层 |
| 2. Browser API surface | 基线 48 个路径已覆盖；HTTP 集成校验主要成功/失败和流式行为 |
| 3. 安全、OAuth、文件路径 | Host/Origin、双层令牌、Cookie、state、上传/静态路径隔离测试通过；真实 OAuth 待用户登录授权 |
| 4. Web 与 Agent/Worker 隔离 | 独立启动器三进程；Agent 崩溃后基础 API 仍可用，原执行别名关闭 |
| 5. Worker 不可用时基础 Rider 存活 | 子进程故障注入和降级 HTTP 验证通过 |
| 6. 各业务端到端回归 | 生成 FIT 的 HTTP 集成、Agent/讲解等隔离回归通过；真实账号流程仍待验收 |
| 7. 路线幂等、revision、fail-closed | 现有测试与完整 Python 回归通过；未改路线算法/恢复 |
| 8. 数据升级/备份 | 复用既有 schema owner 和预检/备份工具；本轮未变更数据库 schema |
| 9. 静态资产不依赖 Node 运行 | 独立发布目录、真实浏览器及 Windows SDK 请求通过，无 node_modules |
| 10. Windows/统一启动无需 Node | Windows 原生 Python 实测通过；另已通过独立 venv 安装、pip check 和基础启动；尚非完整业务验收 |
| 11. 兼容观察周期 | 尚未完成日常使用观察；不能用一次自动回归替代 |
| 12. 回退演练 | 同端口 Python→Node→Python 数据读写保留通过 |

真实授权验收已向用户询问配合时间。在得到结果和兼容观察证据前，目标保持未完成，默认入口保留。没有自动切换、提交或推送。

当前目标状态：blocked。真实账号授权、设备骑行与日常兼容观察仍需用户参与；自动验收无法替代。已询问真实 OAuth 配合时间，尚未收到答复。目标未完成，保留默认入口及所有未提交改动。
