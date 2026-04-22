# Git 提交命名约定

本文档约定本仓库后续统一采用一套简洁的提交命名风格，便于查看历史、筛选改动类型、后续生成变更记录。

## 1. 基本格式

推荐格式：

```text
type: short summary
```

如需补充说明，可在第二行空行后继续写：

```text
type: short summary

- change 1
- change 2
```

## 2. 基本原则

- `type` 使用英文小写。
- `summary` 用英文，简短直接，描述本次改动的主要意图。
- 第一行只写一件最核心的事情，不要把多个无关改动塞进同一个标题。
- 优先写“做了什么”，不要写“为了什么讨论了一半”。
- 没有必要时不加 scope，保持简洁。

## 3. 本项目推荐类型

### `feat`

用于新增用户可感知的新功能。

适用场景：

- 新增训练模式
- 新增自定义训练目标
- 新增 Strava 上传能力
- 新增街景或 PiP 功能
- 新增新的骑行控制能力

示例：

```text
feat: add custom workout target planner
feat: support strava fit upload endpoint
feat: add immersive street view entry
```

### `fix`

用于修复 Bug、错误行为、回归问题。

适用场景：

- 修复 GPX 预览不显示
- 修复输入框内容不可见
- 修复风阻公式错误
- 修复模拟结果异常

示例：

```text
fix: correct wind drag direction in cycling model
fix: render elevation preview after gpx import
fix: keep custom workout input visible while typing
```

### `refactor`

用于重构代码结构，不以新增功能或修 Bug 为主，原则上不改变对外行为。

适用场景：

- 拆分 renderer
- 引入 `ride snapshot`
- 新增采样层
- 抽离 `ride-engine`
- 蓝牙控制抽象层重组

示例：

```text
refactor: split ride dashboard renderers
refactor: add ride snapshot pipeline
refactor: extract workout runtime renderer
```

### `chore`

用于项目整理、辅助工具、目录迁移、非核心业务代码维护。

适用场景：

- 整理 `demos/` 目录
- 新增分析用 demo 页面
- 调整项目文件布局
- 小型维护性改动

示例：

```text
chore: organize demos and add ftms frequency tester
chore: move global stylesheet into src
chore: rename demo folders for consistency
```

### `docs`

用于文档新增或修改。

适用场景：

- 更新 `physics.md`
- 补充结构说明
- 新增开发记录
- 完善使用说明

示例：

```text
docs: add physics tuning notes
docs: update project structure summary
docs: record 0422 development notes
```

### `test`

用于新增或调整测试，不以功能代码修改为主。

适用场景：

- 增加物理模型测试
- 增加回归测试
- 调整测试夹具

示例：

```text
test: cover speed simulation on flat and grade routes
test: add regression case for live ride snapshot
test: expand trainer command integration coverage
```

## 4. 可选类型

以下类型可以使用，但本项目当前不会特别频繁：

- `perf`
  - 性能优化，如减少无意义重绘、优化高频更新
- `style`
  - 纯格式调整，不改变逻辑
- `build`
  - 构建工具、依赖、打包配置修改
- `ci`
  - CI/CD 配置相关

## 5. 如何选择类型

可以按下面的顺序判断：

1. 是不是新增正式功能？
   - 是，用 `feat`
2. 是不是修复错误或异常行为？
   - 是，用 `fix`
3. 是不是主要在改结构、职责边界、模块拆分？
   - 是，用 `refactor`
4. 是不是目录整理、辅助页、配置、开发维护？
   - 是，用 `chore`
5. 是不是只改文档？
   - 是，用 `docs`
6. 是不是只改测试？
   - 是，用 `test`

## 6. 本项目提交示例

结合当前仓库，推荐类似下面的写法：

```text
feat: add custom workout target runtime
fix: restore gpx elevation preview rendering
refactor: extract svg chart builders
refactor: add sensor sampling layer
docs: add commit naming convention
test: cover cycling model speed across grades
chore: organize demos and add ftms frequency tester
```

## 7. 不推荐的写法

不推荐：

```text
update
fix bug
modify code
搞一下训练逻辑
refactor: fix bug and add feature and update docs
```

原因：

- 信息太少，后续看历史无法判断改动内容。
- 同时混入多个目的，无法快速分类。
- 中英文风格不统一。

## 8. 当前执行约定

从本文档建立后，后续提交默认遵循以下风格：

- 标题格式统一为 `type: summary`
- 标题使用英文
- 类型优先从 `feat / fix / refactor / chore / docs / test` 中选择
- 一次提交尽量只表达一个主目的

如果一次改动同时包含多个方向，优先按“主改动”选择类型；必要时拆成多次提交。
