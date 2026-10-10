# 多日路线隔离验收（2026-09-22）

本轮由独立 Agent 检查 Python 服务、持久化和组合操作，主 Agent 检查 API、浏览器服务和恢复边界。未修改业务代码；未调用真实模型、地图或账号。Provider 与断网使用故障注入，Service、SQLite、View、Route Agent/API 定向测试及浏览器业务服务使用实际实现。

## 已复现问题

### P2：无实质变化的修改也清空当天路线

位置：`services/training-agent/services/route/daily_itinerary.py:112-124`。

当天已经生成后，仅传 `candidate_name="改个名称"`，或原样传回相同的 `waypoints`，都会执行 `day.clear()`，删除几何、确认记录，并变为 `needs_regeneration`。这会导致语言修改把完整参数重复传回时出现不必要重算。

建议区分显示信息、验收要求与实际算路参数。相同参数不失效；改名保留几何；真正改变道路请求的修改才重算。

### P2：重生成失败后，旧成果与失败记录混在同一对象

位置：`services/training-agent/services/route/daily_itinerary.py:164-171`、`services/training-agent/services/route/view.py:80`。

先生成 60 km、12000 秒的路线，再注入高德限流异常：当前记录变为 failed、geometry 消失，却仍投影 `distance_m=60000`、`provider_duration_s=12000`、`distance_satisfied=true`。

浏览器每日卡片目前对非 ready 状态隐藏距离与时间，**不是页面必然显示旧里程**；问题在持久化与输出契约混合新旧结果，并且旧成果无法直接预览。已验证 undo 可以恢复上次 ready 路线。

建议独立保留最后成功路线与本次生成诊断，避免失败覆盖成功成果；返回值明确各自适用的版本和状态。

### P2：响应中断后，直接重试仍发送旧版本

位置：`src/app/services/agent-route-preview-service.js:196-208`。

使用实际浏览器业务服务注入“已保存但响应断开”：服务端版本从 1 变为 2，前端仍为 1；第二次点生成仍发送 expected_revision=1，收到 409。重新加载会话通过 get 读取最新版本，能够恢复为 2。路线并未从数据库丢失。

建议对不确定完成状态先读取最新计划，再决定展示已有成果或允许重试；不要直接重复提交旧版本。

## 已通过和边界

- 前一轮加入的未确认/已确认路线保留、修改相邻日起点后数据库重载测试仍通过。
- 重生成失败后 undo 可以恢复之前路线。
- 逐日失败如实返回错误，最新行程版本保留；现有 API 和 Route Agent 回归通过。
- 多进程或绕过 API 会话锁直接并发调用服务时，全计划 CAS 会使另一日编辑与生成冲突，生成日可能停在 generating。普通同会话 API 会串行，此项仅作潜在恢复风险，不作为普通 UI 必现问题。
- 存在跨日衔接警告时，原确认记录仍保存，但 View 会暂时显示未确认、确认接口拒绝。这是当前显式策略，不按确定性 bug 统计。

## 执行记录

- 独立 Agent：`test_daily_itinerary.py` 16 项通过，另运行组合探针 `/tmp/daily_route_audit_probe.py`。
- 主 Agent：`test_api.py`、`test_route_agent.py`、`test_route_confirmation.py` 共 79 项通过；`npm test` 451 项通过。
- 浏览器断网探针：`/tmp/daily-ui-retry-probe.mjs`，输出首次断开、第二次 409、重载恢复版本 2。
- 临时探针可能被系统清理；本文保留其场景和结果。没有真实浏览器视觉或真实地图路线质量验收。

## 后续处理

问题 1、2 已修复：无实质变化/改名保留路线；距离要求变更只重新验收；道路变更和生成失败使用独立的最后成功快照，页面可明确预览旧版但不能确认。问题 3 的断网版本恢复保持遗留。
