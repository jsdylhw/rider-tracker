let pipWindow = null;

document.getElementById('pipBtn').addEventListener('click', async () => {
    if (pipWindow) {
        // 如果悬浮窗已存在，点击则关闭它
        pipWindow.close();
        return;
    }

    try {
        // 1. 请求开启 Document Picture-in-Picture 窗口
        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: 280,
            height: 120,
            disallowReturnToOpener: true // 隐藏"返回到标签页"的按钮
        });

        // 2. 克隆模板内容
        const template = document.getElementById('pip-template');
        const pipContent = template.content.cloneNode(true);
        pipWindow.document.body.append(pipContent);
        
        // 动态渲染悬浮窗内部 DOM
        window.reRenderPiP();

        // 3. 注入主窗口的 CSS 样式
        [...document.styleSheets].forEach(styleSheet => {
            try {
                const cssRules = [...styleSheet.cssRules].map(rule => rule.cssText).join('');
                const style = document.createElement('style');
                style.textContent = cssRules;
                pipWindow.document.head.appendChild(style);
            } catch (e) {
                // 处理外部样式表跨域限制
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.type = styleSheet.type;
                link.media = styleSheet.media;
                link.href = styleSheet.href;
                pipWindow.document.head.appendChild(link);
            }
        });

        // 4. 初始化数据并更新按钮状态
        window.updatePiPData();
        document.getElementById('pipBtn').innerText = '关闭悬浮窗';
        document.getElementById('pipBtn').style.backgroundColor = 'var(--danger)';

        // 5. 监听悬浮窗被用户手动关闭的事件
        pipWindow.addEventListener('pagehide', () => {
            pipWindow = null;
            document.getElementById('pipBtn').innerText = '开启悬浮窗';
            document.getElementById('pipBtn').style.backgroundColor = 'var(--secondary)';
        });

    } catch (error) {
        console.error('开启悬浮窗失败', error);
        alert('开启悬浮窗失败，请确保使用最新版 Chrome 或 Edge 浏览器。');
    }
});

// 根据全局配置重新生成悬浮窗的 DOM 结构
window.reRenderPiP = function() {
    if (!pipWindow) return;
    
    const container = pipWindow.document.getElementById('pip-dynamic-row');
    if (!container) return;
    
    container.innerHTML = ''; // 清空原有内容
    const config = window.pipConfig;

    if (config.hr) {
        container.innerHTML += `
            <div class="pip-data">
                <span class="pip-icon hr-icon">❤️</span>
                <span id="pipHeartRate">--</span>
                <span class="pip-unit">bpm</span>
            </div>`;
    }
    
    if (config.power) {
        container.innerHTML += `
            <div class="pip-data">
                <span class="pip-icon power-icon">⚡</span>
                <span id="pipPower">--</span>
                <span class="pip-unit">W</span>
            </div>`;
    }

    if (config.time) {
        container.innerHTML += `
            <div class="pip-data time-color">
                <span class="pip-icon time-icon">⏱️</span>
                <span id="pipTime">00:00</span>
            </div>`;
    }

    if (config.np) {
        container.innerHTML += `
            <div class="pip-data np-color">
                <span class="pip-icon">NP</span>
                <span id="pipNp">--</span>
                <span class="pip-unit">W</span>
            </div>`;
    }

    // 重建DOM后，立即填充一次当前最新数据
    window.updatePiPData();
};

// 暴露给 app.js 调用的数据更新函数
window.updatePiPData = function() {
    if (!pipWindow) return;
    
    const data = window.currentData;

    const hrEl = pipWindow.document.getElementById('pipHeartRate');
    const powerEl = pipWindow.document.getElementById('pipPower');
    const timeEl = pipWindow.document.getElementById('pipTime');
    const npEl = pipWindow.document.getElementById('pipNp');
    
    if (hrEl) hrEl.innerText = data.hr;
    if (powerEl) powerEl.innerText = data.power;
    if (timeEl) timeEl.innerText = data.time;
    if (npEl) npEl.innerText = data.np;
};
