# Map Route Planner Demo

这个目录是独立 Demo，用来验证“地图点选路线 -> Google Routes -> Rider Tracker route JSON -> 动态骑行转向重规划”的最小闭环。

它不接入主项目运行流程，也不修改 `route-service`、`map-controller`、`ride-engine` 等现有模块。

## 功能范围

- 输入 Google Maps API Key
- 加载 Google Map
- 点击地图选择起点和终点
- 可加载预置旧金山网格 GPX 路线，便于测试路口转向
- 调用 Google Routes API 获取路线 polyline
- 对 polyline 按距离采样
- demo 暂不请求海拔，路线按 0 海拔 / 0 坡度处理
- 计算累计距离
- 输出 Rider Tracker 内部 route JSON
- 绘制简单路线预览
- 按设定速度沿路线匀速模拟骑行
- 输入左拐 / 直行 / 右拐命令，尝试在当前位置前方 50m 内找到可转向点并重算未来路线

## 启动方式

建议用本地 HTTP 服务打开，避免浏览器对 `file://` 模块脚本的限制：

```bash
cd /home/liuhaowen/codes/rider-tracker
python -m http.server 8080
```

浏览器访问：

```text
http://localhost:8080/demos/map-route-planner-demo/index.html
```

## Google API 要求

同一个 API Key 至少需要启用：

- Maps JavaScript API
- Routes API
- Roads API（用于路口转弯时的路径吸附）

如果 API Key 配置了 HTTP referrer 限制，需要允许本地测试地址，例如：

```text
http://localhost:8080/*
```

## 动态转向算法

左右拐弯采用 **路径吸附** 算法：

1. 在当前位置前方 10m - 50m 范围，以 10m 步进寻找候选锚点
2. 从锚点垂直投影 20m 到目标方向（左 -90° / 右 +90°）
3. 调用 Roads API `nearestRoads` 同时吸附锚点和侧向点
4. 通过 `placeId` 判断是否在不同的道路（即存在真实交叉路口）
5. 以吸附后的侧向点作为途经点，沿目标道路方向投影 500m 作为终点
6. 调用 Routes API 规划新路线
7. 验证新路线朝向与意图方向一致后，拼接到现有路线

直行延伸：路线到达末端时自动沿当前方向继续规划前方路线。

## 当前限制

- MVP 固定使用 `DRIVE` travel mode。
- 不做路线保存。
- 不接入实时骑行。
- demo 只做模拟骑行中的路线替换/接入，不接真实骑行引擎。
- demo 暂不接入海拔请求，后续接主项目前再补 Elevation。
- 转向路线仍然使用 `DRIVE` travel mode。
- Roads API 吸附依赖网络请求，路口搜索有 ~250ms-1s 延迟。

## 后续接入主项目的建议边界

Demo 跑通后，不建议把页面代码直接搬进主项目。更稳的拆法是：

```text
src/adapters/maps/google-routes-client.js
src/adapters/maps/google-elevation-client.js
src/domain/route/google-route-adapter.js
src/app/services/route-planner-service.js
```

主项目只消费最终生成的 `route`。
