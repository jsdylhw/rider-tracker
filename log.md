# 变更日志

## 2026-04-14

### 单入口页面结构收紧

- 将 `simulation` 与 `live` 页面里的重复导出区域合并为一个共享导出卡片
- 让共享导出卡片在 `simulation/live` 两个视图之间按 `uiMode` 复用
- 清理 `main-view.js` 中对 `fitExportFormLive`、`downloadSessionBtnLive`、`downloadFitBtnLive` 的重复 DOM 依赖
- 清理 `export-renderer.js` 中对双导出表单的重复同步逻辑
- 清理 `dashboard-renderer.js` 中对旧 live 导出卡片的显隐依赖
- 保持实时骑行进行中隐藏导出卡片，结束后再显示

### 第三轮结构收紧

- 新增 `layout-coordinator.js`，把页面模式切换、共享卡片布局和首页历史摘要展示从 `main-view.js` 下沉
- `main-view.js` 继续瘦身，聚焦主装配与公共渲染流程
- 将根目录 `pip.js` 收回 `src/ui/pip/pip-controller.js`
- 更新 `bootstrap.js` 中的 PiP 引用路径，消除根目录 UI 特例文件

### 首页流程与虚拟骑行入口调整

- 首页改为显示项目简介、个人数据、历史数据和训练线路配置
- 新增“确认线路”流程，确认后隐藏个人数据与历史数据，显示训练模式选择
- 首页路线配置阶段隐藏路线地图，只保留线路编辑和 GPX 导入
- 进入虚拟骑行模式后弹出设备连接层，引导先连接功率计与心率带再开始骑行
