# Rider Tracker - TODO

> 运行环境：仅 localhost (127.0.0.1:8787)，不对外暴露

---

## 优先级 P0 — 功能正确性 Bug（影响骑行体验）

- [ ] **startRide() 竞态条件** — 循环启动可能早于 state 更新，首个 tick 看到 null session 导致立即终止
  - 文件：`src/app/services/ride-service.js:34-81`
  - 修复：先 setState，再用微任务延迟启动循环

- [ ] **stopRide() 持久化顺序错误** — saveLastSession() 异常会导致骑行卡在 isActive:true
  - 文件：`src/app/services/ride-service.js:118-189`
  - 修复：先更新 store 状态，再异步保存（catch 错误不影响状态）

- [ ] **stopRide() in-place 对象变异** — 直接修改传入对象导致调用者数据污染
  - 文件：`src/app/services/ride-service.js:343-357`
  - 修复：使用 defensive copy

- [ ] **canStartRide() 逻辑判断不一致** — externalPowerConnected:true 但 activePowerSource:"none" 时误允许启动
  - 文件：`src/app/services/device-service.js:410-413`

---

## 优先级 P1 — 性能与稳定性

- [ ] **live-ride-session 每 tick 复制整个 records 数组** — 长骑行（3h+）性能瓶颈
  - 文件：`src/domain/ride/live-ride-session.js`
  - 建议：改用写时复制或 TypedArray buffer

- [ ] **页面关闭时未断开 BLE 连接** — 蓝牙设备资源泄漏
  - 文件：`src/app/bootstrap.js:91-95`
  - 修复：beforeunload 中调用 deviceService.disconnectAll()

- [ ] **Strava HTTP 请求无超时** — API 挂起时阻塞事件循环
  - 文件：`src/server/strava-client.js`
  - 修复：添加 AbortController + 30s 超时

- [ ] **OAuth state Map 无定期清理** — 用户不完成流程时内存泄漏
  - 文件：`src/server/routes/strava-routes.js`
  - 修复：添加定时清理过期条目

- [ ] **Token 存储读写竞态条件** — 并发 set() 可能丢失数据
  - 文件：`src/server/token-store.js:29-32`
  - 修复：使用原子写（tmp + rename）

- [ ] **buildColoredSegments SVG DOM 膨胀** — 长路线 1000+ <line> 元素性能差
  - 建议：改用 <polyline> 或 canvas

---

## 优先级 P2 — 代码质量与可维护性

- [ ] **SQL 改用参数化查询** — activity-store.js 当前用字符串插值
  - 修复：转换为 db.prepare() + stmt.run()

- [ ] **escapeHtml() 重复定义** — 6 个 renderer 文件各自定义
  - 修复：提取到 `src/shared/html-utils.js`

- [ ] **downsamplePoints() 重复定义** — 2 处独立实现
  - 修复：统一到 `src/shared/chart-utils.js`

- [ ] **核心指标计算重复** — calculateIntensityFactor/calculateVariabilityIndex 在 ride-metrics 和 live-ride-session 各有一份
  - 修复：集中在 ride-metrics.js，其他模块导入

- [ ] **速度限制常数不一致** — cycling-model 35 m/s vs simulator 33.3 m/s
  - 修复：统一为单一常数定义

- [ ] **estimateHeartRate() 从未调用** — 死代码
  - 文件：`src/domain/physiology/heart-rate-model.js`

- [ ] **混合语言本地化** — 部分状态文本英文，大部分中文

---

## 优先级 P3 — 功能增强

- [ ] **FIT 导出增强** — 加入个人数据、训练区间等内容，结合 Garmin 文件增加功能

- [ ] **沉浸式街景退出状态不持久** — 下次 render() 时恢复
  - 修复：将街景状态持久化到 store 或 localStorage

- [ ] **物理模型空气密度硬编码** — 高海拔路线 10-20% 误差
  - 建议：参数化或根据海拔动态计算

- [ ] **multer 添加文件大小限制** — 当前无 limits 配置

- [ ] **FIT SDK CDN 加载无完整性验证** — 无 SRI hash

---

## 优先级 P4 — 架构改进（长期）

- [ ] **dashboard-renderer 拆分** — 拆成 LiveMetricsRenderer（高频）、RideVisualRenderer（中频）、StreetViewRenderer（低频）

- [ ] **main-view.js 工厂函数 60+ 参数** — 改用 config 对象模式降低耦合

- [ ] **服务器层补充测试** — routes、token-store、config-store、strava-client 均无测试

---

## 安全备注（localhost 场景降级）

以下问题在纯 localhost 运行下风险极低，暂不处理：
- API 无认证（仅本地访问）
- CORS 完全开放（仅本地）
- OAuth 凭证明文存储（本地文件系统）
- 若未来有任何公网暴露需求，必须优先解决这三项