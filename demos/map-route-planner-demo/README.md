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
- 输入左拐 / 直行 / 右拐命令，在当前位置前方 50m 内扫描路口，预生成后续路线，并在 20m 内输出控制提示

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

左右拐弯采用 **命令排队 + 网格探测 + 路径吸附** 算法：

1. 用户输入左拐 / 右拐后，命令先进入 pending 状态，不立即替换路线
2. 模拟骑行 tick 中持续扫描当前位置前方 50m 内的候选区域
3. 候选区域使用前向距离 `5/10/15/20/30/40/50m` 和侧向距离 `5/10/15/20m` 组合成小网格点
4. 调用 Roads API `nearestRoads` 批量吸附锚点和侧向点
5. 通过 `placeId`、吸附距离和转向角度过滤旁边道路，避免把平行路误判成可转路口
6. 以吸附后的侧向点作为途经点，沿转向方向投影约 500m 作为终点
7. 调用 Routes API 预生成新路线，并验证新路线朝向与意图方向一致
8. 距离转向点 20m 内时输出控制提示，距离约 5m 时把新路线拼接到现有路线

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
我觉得你发现了一个**比较关键的方向**，而且它可能比你现在的 "Roads API + Routes API 不断请求" 更适合做城市浏览。

先分析一下现在两种思路。

---

# 方案一：地图驱动（你现在的 Demo）

整个流程是：

```text
当前位置
↓

Roads API
↓

找到附近道路

↓

Routes API

↓

生成下一段路线

↓

继续走
```

如果一直走：

```text
每隔10m

↓

Roads

↓

Routes

↓

Roads

↓

Routes
```

请求量会越来越大。

例如：

```
一公里：

100 次 Roads

30 次 Routes
```

如果一个人逛一个小时：

```
几百上千次 API
```

这个成本其实不低。

---

# 方案二：Street View 驱动

Google Street View 自己其实已经知道：

```text
Panorama A

↓

Panorama B

↓

Panorama C

↓

Panorama D
```

它内部已经维护好了：

```
哪些 Panorama 相邻

heading

links

```

实际上每一个 panorama 都有：

```json
{
    pano: "...",
    location: {...},
    links:[
        {
            heading:12,
            pano:"xxxx"
        },
        {
            heading:97,
            pano:"yyyy"
        }
    ]
}
```

也就是说：

Street View 自己就是一张图(Graph)。

---

## 举个例子

现在人在：

```
A
```

Street View 返回：

```
links

↓

北

东

西
```

你完全不用：

```
Roads API
```

也不用：

```
Routes API
```

因为：

```
StreetView

↓

已经告诉你

↓

下一步有哪些方向
```

---

# 自动前进

例如：

```
当前 heading = 32°
```

links：

```
30°

120°

275°
```

直接选：

```
30°
```

继续。

就是：

```
A

↓

B

↓

C

↓

D
```

整个过程中：

没有 Roads。

没有 Routes。

---

# 左转

假设：

```
heading=0°
```

links：

```
358°

92°

271°
```

直接：

```
92°

就是左转
```

继续。

是不是很像游戏？

---

# 到路口

Street View：

```
links:

前

左

右
```

本身就是：

```
Road Graph
```

Google 已经算好了。

---

# 你的请求量为什么会下降？

因为：

原来：

```
当前位置

↓

Google 算路线

↓

Google 找道路

↓

Google 再算路线
```

现在：

```
当前位置

↓

StreetView 已经缓存好了 links

↓

直接移动
```

实际上：

很多情况下：

一次 Panorama

可以玩很久。

---

# 更重要的是

你其实可以完全不用：

```
Roads API
```

甚至：

```
Routes API
```

整个浏览逻辑：

```
Street View

↓

links

↓

Graph Search

↓

移动
```

---

# 我觉得这是一个更大的思路

你现在其实有两个项目方向：

## A

地图导航器

```
Map

↓

Routes

↓

Roads

↓

导航
```

Google Navigation。

---

## B

城市浏览器（我更喜欢）

```
Street View

↓

Panorama Graph

↓

自动浏览

↓

AI

↓

讲解
```

Google Earth。

---

# 甚至可以这样

地图只是：

```
MiniMap
```

真正的大窗口：

```
Street View
```

地图：

```
●

当前位置
```

Street View：

```
██████████████

真正浏览
```

所有移动：

```
Street View links
```

驱动。

地图：

```
同步更新 Marker
```

就够了。

---

# 我甚至建议你再进一步

我觉得你的项目可以改成下面这个架构，而不是现在的 Route Demo。

```
StreetViewEngine
    │
    ├── 当前 panorama
    ├── heading
    ├── links
    ├── 自动前进
    ├── 左右转
    └── MiniMap 同步

MiniMap
    │
    ├── Marker
    ├── Polyline(浏览轨迹)
    └── 当前道路

AI
    │
    ├── 自动探索
    ├── 找景点
    ├── 找咖啡
    ├── 找公园
    └── 介绍城市
```

**我认为这是比当前 Route Demo 更有特色、API 请求也更少的方向。**

不过有一点需要验证：**Street View JS 是否能稳定获取每个 Panorama 的 `links` 信息，并且这些 `links` 是否足够支持连续自动浏览。** 如果这一点成立，你甚至可以把 Roads API 从整个项目里去掉，只在确实需要“规划去某个目的地”时再调用 Routes API，而平时的城市漫游完全依赖 Street View 的图结构。这个我认为值得先做一个小 Demo 验证。
