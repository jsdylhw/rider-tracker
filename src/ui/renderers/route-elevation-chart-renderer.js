import {
    buildElevationProfileSvg,
    buildGradeChartSvg,
    buildRouteChartEmptyStateSvg
} from "./svg/route-charts.js";

export function createRouteElevationChartRenderer({ elements }) {
    function render(route, currentRecord) {
        if (!elements.elevationChart && !elements.setupElevationChart && !elements.rideDashboardElevationChart) return;

        const isDashboardImmersive = elements.rideDashboard?.classList.contains("immersive-street-view") === true;
        if (!route?.points?.length) {
            const emptyGradeState = buildRouteChartEmptyStateSvg("导入路线后显示坡度图");
            const emptyElevationState = buildRouteChartEmptyStateSvg("导入路线后显示距离-海拔图");
            if (elements.elevationChart) elements.elevationChart.innerHTML = emptyGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = emptyElevationState;
            if (elements.rideDashboardElevationChart && !isDashboardImmersive) elements.rideDashboardElevationChart.innerHTML = emptyGradeState;
            return;
        }

        if (route.hasElevationData === false) {
            const noGradeState = buildRouteChartEmptyStateSvg("当前 GPX 不包含海拔数据，无法生成有效坡度图");
            const noElevationState = buildRouteChartEmptyStateSvg("当前 GPX 不包含海拔数据，无法生成有效距离-海拔图");
            if (elements.elevationChart) elements.elevationChart.innerHTML = noGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = noElevationState;
            if (elements.rideDashboardElevationChart && !isDashboardImmersive) elements.rideDashboardElevationChart.innerHTML = noGradeState;
            return;
        }

        const gradeChartSvg = buildGradeChartSvg(route, currentRecord);
        const elevationProfileSvg = buildElevationProfileSvg(route, currentRecord);
        if (elements.elevationChart) elements.elevationChart.innerHTML = gradeChartSvg;
        if (elements.rideDashboardElevationChart && !isDashboardImmersive) {
            elements.rideDashboardElevationChart.innerHTML = elevationProfileSvg;
        }
        if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = elevationProfileSvg;
    }

    return { render };
}
