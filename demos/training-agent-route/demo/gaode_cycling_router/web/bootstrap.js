(async () => {
  const status = document.querySelector("#status");
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || "高德配置读取失败");
    window._AMapSecurityConfig = config.security_js_code ? { securityJsCode: config.security_js_code } : {};
    const mapScript = document.createElement("script");
    mapScript.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.js_key)}&plugin=AMap.ToolBar,AMap.Scale`;
    mapScript.onload = () => {
      const appScript = document.createElement("script");
      appScript.src = "/static/app.js";
      document.body.append(appScript);
    };
    mapScript.onerror = () => { status.textContent = "高德 JS API 加载失败"; status.className = "status error"; };
    document.head.append(mapScript);
  } catch (error) {
    status.textContent = error.message;
    status.className = "status error";
  }
})();
