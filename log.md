# 变更日志

## 2026-04-14

### 单入口页面结构收紧

- 将 `simulation` 与 `live` 页面里的重复导出区域合并为一个共享导出卡片
- 让共享导出卡片在 `simulation/live` 两个视图之间按 `uiMode` 复用
- 清理 `main-view.js` 中对 `fitExportFormLive`、`downloadSessionBtnLive`、`downloadFitBtnLive` 的重复 DOM 依赖
- 清理 `export-renderer.js` 中对双导出表单的重复同步逻辑
- 清理 `dashboard-renderer.js` 中对旧 live 导出卡片的显隐依赖
- 保持实时骑行进行中隐藏导出卡片，结束后再显示
