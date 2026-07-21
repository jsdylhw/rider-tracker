# FTMS Wind Resistance Demo

这个独立 demo 用 FTMS `0x11 Set Indoor Bike Simulation Parameters` 验证骑行台是否接受风速、坡度、`Crr` 和 `Cw`。

## 启动

```bash
cd /home/liuhaowen/codes/rider-tracker
python -m http.server 8080
```

打开 <http://localhost:8080/demos/ftms-wind-resistance-demo/index.html>。需要 Chrome 或 Edge，并在 `localhost` 或 HTTPS 下使用 Web Bluetooth。

## 风向约定

- “风从方向”是气象约定，北风填 `0`，南风填 `180`。
- 页面根据骑行方向投影成 FTMS 的一个签名风速：正值为逆风，负值为顺风。
- FTMS 没有侧风字段，纯侧风投影为约 `0 m/s`。侧风造成的额外空气阻力不能直接由 `0x11` 表达。
- `Cw = 0.5 * 1.226 * CdA`，单位为 `kg/m`；例如 `CdA 0.35 m²` 会写入约 `Cw 0.215 kg/m`（编码后为 `0.21`）。

## 实机验证步骤

1. 先断开其他正在控制骑行台的软件，保持设备安全、低阻力状态。
2. 连接骑行台，确认页面显示 Control Point ready。
3. 在 `0%` 坡度下依次试 `4 m/s` 逆风、无风、`4 m/s` 顺风；每次勾选确认后发送一次。
4. 保持接近相同的踏频和速度，记录阻力感、设备速度/功率以及日志中的 `0x11` 成功响应。
5. 再以固定风速改变 `CdA`，对比 `Cw` 字段和设备反馈。

控制点返回 `success` 只说明设备接受了命令，不保证固件确实使用风速字段。若实机感觉和读数均无变化，记录日志、车型和固件版本；主程序应继续发送坡度，并把该设备标记为“原生风阻未验证”。
