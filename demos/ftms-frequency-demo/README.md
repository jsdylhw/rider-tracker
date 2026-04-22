# FTMS Frequency Demo

本目录是一个独立 Demo，用来测试骑行台通过 FTMS `Indoor Bike Data` 上报数据的通知频率，便于后续分析：

- 实际通知间隔是否稳定
- 近似通知频率（Hz）
- 功率、踏频、速度字段的出现比例
- 某些设备是否存在抖动、突发、断流

## 启动方式

请使用本地 HTTP 服务或 `https` 环境打开，不要直接双击 `file://`：

```bash
cd /home/liuhaowen/codes/rider-tracker
python -m http.server 8080
```

浏览器访问：

- <http://localhost:8080/demos/ftms-frequency-demo/index.html>

推荐浏览器：最新版 Chrome / Edge（支持 Web Bluetooth）。

## 操作步骤

1. 点击“连接骑行台”
2. 选择支持 FTMS 的骑行台设备
3. 保持踩踏或空转，观察页面上的包间隔、Hz 和字段占比
4. 如需重新测试，点击“清空日志”

## 当前实现

- 连接 FTMS 服务 `0x1826`
- 订阅 `Indoor Bike Data` 特征 `0x2AD2`
- 解析速度、踏频、功率字段
- 记录每个通知的到达时间并统计平均间隔与近似频率
