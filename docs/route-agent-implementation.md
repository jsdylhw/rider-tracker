# Route Agent 结构整改交付记录

本项收敛 Agent 调用、任务状态和跨入口草稿接续，不属于 Python 目录迁移，不修改冻结架构或迁移 ADR。

## 当前调用链

```text
主对话 → Main Agent → activate_skill(plan-routes) → run_route_agent
                                                        ↓
AI 路线页面 → Node BFF → Python /api/chat → RouteTaskInput → Route Agent
                                                        ↓
                                  创建/修改 Tool → Service → Provider / Repository
```

主对话 Skill 只授权委派工具。Route Agent 不递归调用 Main Agent，不使用 Worker。
普通主对话每轮选择 Skill；前端关键词截流和后端沿用历史路线 Skill 的路径已移除。

## 已完成的结构边界

| 边界 | 当前行为 |
| --- | --- |
| 任务契约 | `route_task_input.v1`；workspace/request ID 由服务端提供，plan ID 与 revision 成对校验 |
| 结果契约 | 原 `agent_turn.v1`、`route_plan_view.v1` 增加 `route_task.v1` 摘要；只有本轮真实计划投影才算成功 |
| Context 隔离 | 子级仅使用独立 route_messages，不继承活动选择、主历史或父级工具权限 |
| 更新目标 | 模型不能覆盖服务端绑定的计划与版本；外部工作区或过期引用在模型执行前拒绝 |
| 新任务失败 | 清空旧任务引用，保留新任务对话；旧预览不能被误用作后续修改目标 |
| 服务端选项 | 创建和更新均以任务 include_elevation 为准，覆盖模型输入 |
| 失败出口 | 澄清、业务拒绝、Provider 失败和模型失败分别投影；失败不能携带旧草稿冒充成功 |
| 父级结束 | 完成、澄清和失败均终结委派回合，不重复委派或重放底层路线失败动作 |
| 页面命令 | 预览、反转、撤销、最终确认继续使用确定性命令，不由模型自动确认 |

`action_executed` 只代表进入业务工具，不代表成功。refine 可以修改，也可在区域实质变化时另建。

## 工具终止规则

- action=create/update/refine 分别授权创建、更新或两者，均允许专用澄清工具。
- 创建/更新工具或澄清返回后终止；越权调用终止并保留诊断。
- 本提交不包含网页搜索工具，搜索及后续规划功能保留在工作区继续开发。

## 跨入口接续

主对话成功卡片捕获来源 session_id、plan_id、revision。打开草稿使用只读 get，并验证 expected_revision；
get 不修改后端 route_reference，即使响应迟到或被页面丢弃也不会切换目标。
页面后续操作使用原来源会话，不合并任意工作区。草稿进入 agentRouteDraft，地图与候选同步。
主对话清空不改变已打开草稿的来源；确定性修改只刷新同 plan_id 的当前任务版本。
并发修改由 expected_revision 拒绝，打开草稿不等于确认保存。

## 尚未完成的独立能力

- 更接近用户目标的距离规划与路线质量验收。
- 完整总时间预算、取消、持久化失败候选恢复、路线专用重试命令。
- Google 访问链路稳定性。真实同参数请求在 urllib/requests 均复现 TLS EOF；直连也失败。
  尚不能定位具体断开的网络节点；非 JSON 400 不直接归因为网关，原有有界重试保留。
- 模型的控制点语义提取仍可能有误，搜索接入不是路线质量保证。

距离和真实网络结果见 [真实对话验证](route-distance-dialogue-validation.md)；
成功地点缓存及后续恢复边界见 [错误恢复](route-planning-recovery.md)。

## 验收记录

以下真实浏览器和全量测试记录来自包含搜索功能的工作区，不等于本提交快照的独立全量验证。

最终统一回归和浏览器验收记录见下方交付验收。历史定向测试数字不再作为当前整体通过依据。

### 交付验收（2026-09-18）

- 拆出搜索改动前的完整工作区统一执行 `npm run test:all`：JavaScript 434 项、Python 801 项、正常双进程集成和后端掉线恢复集成通过。
- 浏览器发现并修复 `bootstrap.js` 遗留的未定义 `persistedSession`，避免中断用户资料初始化。
- Chromium 实际访问隔离 Node BFF/Python 服务，调用真实模型、Tavily 与 Google（当时工作区包含未提交的搜索功能）；主对话生成
  “京都三条大桥到四条大桥，不限距离”草稿，页面打开成功；反转命令 HTTP 200，最终确认 HTTP 200。
- 返回主对话再次打开原 revision 1 卡片，得到 HTTP 409；当前已确认计划保持 revision 3，
  隔离库中保存路线 1 条。确认按钮状态和文本通过 DOM 校验。
- 浏览器自动化使用应用初始化完成和命令响应作为等待条件。早期脚本曾因初始化未完成或错误点击
  已自动关闭的主对话窗口而超时，未把这些脚本失败计为产品通过；最终记录为
  `/tmp/route-browser-verified.txt`，截图 `/tmp/route-browser-confirm.png`。
- 测试机缺少中文字形，截图不能用于中文字体外观验收；中文文案以 DOM 文本核对。
- 失败恢复的服务可用性由 `test:degraded` 验证，旧版本失败由真实浏览器验证；未进行实体设备骑行。
- 真实长距离规划和外部网络稳定性仍按上节列为独立待办，不属于本次结构整改完成声明。

本提交合并任务隔离、跨入口状态、距离校验、Google 诊断与验收文档；网页搜索相关改动不包含在本提交中。仅提交源代码、测试和配置示例；本地配置、数据库、浏览器产物和 `output/` 不纳入。

最终回归曾暴露活动接口测试把真实时钟剩余预算精确断言为 2000 ms 的偶发失败（实际 1999 ms）；
通过该接口已有的 now 注入点固定测试时钟，不改变业务代码，独立归类为测试稳定性修正。

### 提交范围调整

结构整改合并为一个本地提交；搜索工具及其配置、来源展示和相关测试保留为未提交开发改动。
不含搜索的暂存快照单独验证：JavaScript 434 项、Route Agent/对话/Skill/Provider 定向 Python 52 项通过。
