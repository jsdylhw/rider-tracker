// Present existing provider conclusions without recalculating route quality.
export function routeCardPresentation(candidate) {
    const warnings = candidate.warnings ?? [];
    const notices = [];
    for (const warning of warnings) {
        if (warning.includes("驾车路径") && warning.includes("虚拟")) {
            notices.push("使用驾车道路生成，仅供虚拟骑行。");
        } else if (warning.startsWith("当前材料缺少可用的")) {
            const preferences = warning.match(/^当前材料缺少可用的(.+?)走廊/);
            notices.push(preferences ? `${preferences[1]}偏好尚未确认满足。` : warning);
        } else if (!/^(Google 估算爬升|估算爬升暂不可用|本次未使用 Strava|本轮仅找到|沿线偏好按连续控制点|景观偏好已用于|未能确定的可选地点)/.test(warning)) {
            // Unrecognized warnings remain visible, including distance/constraint failures.
            notices.push(warning);
        }
    }
    const description = candidate.description || "请预览地图，选择适合的路线。";
    const brief = description.replace(/^从.+?出发[，,]?/, "");
    return {
        description: brief && brief !== "。" ? brief : "请展开路线详情查看起终点。",
        notices: [...new Set(notices)],
        details: [...new Set([description, ...warnings])]
    };
}
