export function isCurrentRouteRequest(requestGeneration, currentGeneration) {
    return requestGeneration === currentGeneration;
}

export function scaleRoutePointDistances(routePoints, totalDistanceMeters) {
    if (!Array.isArray(routePoints) || routePoints.length === 0) return routePoints;

    const sampledDistanceMeters = Number(routePoints.at(-1)?.distanceMeters);
    const finalDistanceMeters = Number(totalDistanceMeters);
    if (!(sampledDistanceMeters > 0) || !(finalDistanceMeters > 0)) {
        return routePoints;
    }

    const scale = finalDistanceMeters / sampledDistanceMeters;
    return routePoints.map((point, index) => ({
        ...point,
        distanceMeters: index === routePoints.length - 1
            ? finalDistanceMeters
            : round(point.distanceMeters * scale, 1)
    }));
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
