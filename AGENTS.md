# Rider Tracker Agent Guide

本文件是自动化编码 Agent 在仓库根目录开始工作的第一入口。开始修改前，先确认实际工作区状态，
不要根据聊天记录或旧文档猜测当前代码。

## 开始前

依次执行：

```bash
pwd
git branch --show-current
git status --short
git log -5 --oneline
```

- 保护工作区中已有的未提交修改；只暂存本次任务明确涉及的文件。
- `config.yaml`、`data/`、FIT、Token 和日志属于本地数据，不读取、不打印、不提交，除非任务明确要求。
- 当前权威架构是 `docs/rider-final-architecture-and-python-migration.md`，实现进展记录在 ADR；不要把计划状态
  反向写入权威架构文档。
- 先阅读 `docs/README.md`，再根据任务进入对应专题文档。

## 当前运行边界

迁移期间的正式入口仍是：

```text
Browser -> Node BFF :8787 -> Python Web API :8000 -> SQLite / files / synchronous paths
                                      |
                                      +-> persisted jobs -> Python Worker
```

- 浏览器 UI、Web Bluetooth、实时骑行、物理计算和 trainer command 保留在 JavaScript。
- Python 是活动、路线、数据库、Agent、Provider 和后台任务的业务 owner。
- Node 正在变为薄 BFF；在 Browser API、安全、上传、OAuth 和静态资源完成等价迁移前，不要提前删除。
- Worker 当前承接报告重建和路线讲解；不要假设主 Agent、AI 路线和同步工作流都已经任务化。
- 正式生产代码不得 import `demos/`。

详细边界和常见改动入口见 `docs/development-guide.md`。

## 修改原则

- 业务规则放在 `src/domain`，用例编排放在 `src/app`，外部 I/O 放在 `src/adapters`，DOM 放在 `src/ui`。
- Python Tool 只做参数/结果适配；确定性业务进入 `services/`，持久化进入 `storage/repositories`，外部服务
  进入 `integrations`。
- 浏览器与 Python 迁移保持原 `/api/*` URL，并先补契约测试，再切换 owner。
- 同一规则只能有一个权威实现。UI 可以显示 readiness、capability 或质量结论，不能另算一套。
- 新 schema、持久化数据或跨进程协议必须版本化；普通内部函数返回值不需要滥用 schema version。
- 不在功能修复中顺手移动大量目录。物理 namespace 和目录整理属于迁移后期独立任务。

## 最小验证

根据改动范围选择最小集合，提交前扩大到受影响层：

```bash
npm test
npm run test:agent
npm run test:integration
npm run test:degraded
python -m compileall -q services/training-agent
git diff --check
```

完整回归使用 `npm run test:all`。新增 JavaScript 单元测试时，确认已经在 `tests/test-runner.js` 注册。
外部网络测试必须与确定性测试分开报告；网络失败不能伪装成代码通过或业务拒绝。

## 提交

遵循 `commit-convention.md`。提交前再次检查：

```bash
git diff --check
git diff --cached --stat
git status --short
```

提交信息说明 `Root cause:`、`Changes:` 和实际运行过的 `Validation:`。未经明确要求不要 push、merge、
删除分支或改写历史。
