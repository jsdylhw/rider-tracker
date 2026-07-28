export const WEB_MERCATOR_MAX_LAT = 85.05112878;
export const DEFAULT_OSM_ROUTE_BOUNDS_SIZE_KM = 10;
export const MAX_OSM_ROUTE_BOUNDS_SIZE_KM = 60;
export const OSM_ROUTE_SAMPLE_SPACING_METERS = 50;
export const ALLOWED_HIGHWAY_PATTERN = "^(trunk|primary|secondary|tertiary|unclassified|residential|living_street)$";

const ALLOWED_HIGHWAYS = new Set([
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street"
]);

export function normalizeLatLng(point) {
    return {
        lat: clamp(point.lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT),
        lng: normalizeLongitude(point.lng)
    };
}

export function buildBoundsAroundRoute(start, destination, {
    minSizeKm = DEFAULT_OSM_ROUTE_BOUNDS_SIZE_KM,
    maxSizeKm = MAX_OSM_ROUTE_BOUNDS_SIZE_KM,
    routePaddingKm = 4
} = {}) {
    const safeStart = normalizeLatLng(start);
    const safeDestination = normalizeLatLng(destination);
    const center = {
        lat: (safeStart.lat + safeDestination.lat) / 2,
        lng: normalizeLongitude((safeStart.lng + safeDestination.lng) / 2)
    };
    const directDistanceKm = haversineDistanceMeters(safeStart, safeDestination) / 1000;
    const sizeKm = clamp(Math.max(minSizeKm, directDistanceKm + routePaddingKm), minSizeKm, maxSizeKm);
    return buildBoundsAroundCenter(center, sizeKm);
}

export function buildBoundsAroundCenter(center, sizeKm = DEFAULT_OSM_ROUTE_BOUNDS_SIZE_KM) {
    const safeCenter = normalizeLatLng(center);
    const halfMeters = sizeKm * 500;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = Math.max(1, metersPerDegreeLat * Math.cos(toRadians(safeCenter.lat)));

    return {
        south: clamp(safeCenter.lat - halfMeters / metersPerDegreeLat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT),
        west: clampLongitude(safeCenter.lng - halfMeters / metersPerDegreeLng),
        north: clamp(safeCenter.lat + halfMeters / metersPerDegreeLat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT),
        east: clampLongitude(safeCenter.lng + halfMeters / metersPerDegreeLng),
        sizeKm
    };
}

export function buildOverpassRoadQuery(bounds) {
    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    return `
        [out:json][timeout:25];
        (
          way["highway"~"${ALLOWED_HIGHWAY_PATTERN}"](${bbox});
        );
        out body;
        >;
        out skel qt;
    `;
}

export function buildSyntheticGridRoadNetwork(bounds, { lineCount = 13 } = {}) {
    const count = clamp(Math.round(lineCount), 3, 25);
    const latitudes = buildLinearValues(bounds.south, bounds.north, count);
    const longitudes = buildLinearValues(bounds.west, bounds.east, count);
    const elements = [];
    const nodeIds = new Map();
    let nextNodeId = 1;
    let nextWayId = 1;

    for (const latitude of latitudes) {
        for (const longitude of longitudes) {
            const id = nextNodeId++;
            nodeIds.set(`${latitude}:${longitude}`, id);
            elements.push({ type: "node", id, lat: latitude, lon: longitude });
        }
    }

    for (const latitude of latitudes) {
        elements.push({
            type: "way",
            id: nextWayId++,
            tags: { highway: "residential", name: "备用网格横向道路" },
            nodes: longitudes.map((longitude) => nodeIds.get(`${latitude}:${longitude}`))
        });
    }

    for (const longitude of longitudes) {
        elements.push({
            type: "way",
            id: nextWayId++,
            tags: { highway: "residential", name: "备用网格纵向道路" },
            nodes: latitudes.map((latitude) => nodeIds.get(`${latitude}:${longitude}`))
        });
    }

    return { synthetic: true, elements };
}

export function buildRoadGraph(overpassData) {
    const nodes = new Map();
    const edges = [];

    for (const element of overpassData?.elements ?? []) {
        if (element.type !== "node") {
            continue;
        }
        nodes.set(element.id, {
            id: element.id,
            lat: element.lat,
            lng: element.lon,
            edges: []
        });
    }

    for (const element of overpassData?.elements ?? []) {
        if (element.type !== "way") {
            continue;
        }

        const highway = element.tags?.highway;
        if (!ALLOWED_HIGHWAYS.has(highway) || !isCyclingAllowed(element.tags)) {
            continue;
        }

        const nodeIds = element.nodes ?? [];
        if (nodeIds.length < 2) {
            continue;
        }

        for (let index = 0; index < nodeIds.length - 1; index += 1) {
            const fromNode = nodes.get(nodeIds[index]);
            const toNode = nodes.get(nodeIds[index + 1]);
            if (!fromNode || !toNode) {
                continue;
            }

            const direction = getBicycleTravelDirection(element.tags);
            if (direction !== "reverse") {
                addDirectedEdge({ edges, fromNode, toNode, wayId: element.id, highway });
            }
            if (direction !== "forward") {
                addDirectedEdge({ edges, fromNode: toNode, toNode: fromNode, wayId: element.id, highway });
            }
        }
    }

    return { nodes, edges, synthetic: overpassData?.synthetic === true };
}

function buildLinearValues(start, end, count) {
    const step = (end - start) / Math.max(1, count - 1);
    return Array.from({ length: count }, (_, index) => round(start + step * index, 7));
}

export function planOsmRoute({ graph, start, destination, sampleSpacingMeters = OSM_ROUTE_SAMPLE_SPACING_METERS }) {
    if (!graph?.edges?.length) {
        throw new Error("OSM 路网为空，无法生成路线");
    }

    const snappedStart = findNearestEdgePoint(start, graph.edges);
    const snappedDestination = findNearestEdgePoint(destination, graph.edges);

    if (!snappedStart || !snappedDestination) {
        throw new Error("起点或终点附近没有可用道路");
    }

    const desiredHeading = bearingDegrees(snappedStart.point, snappedDestination.point);
    const directedStartEdge = chooseEdgeDirection(graph, snappedStart.edge, desiredHeading);
    const directedDestinationEdge = chooseEdgeDirection(graph, snappedDestination.edge, desiredHeading);
    const rawNodes = buildRawRouteNodes({
        graph,
        snappedStart,
        snappedDestination,
        directedStartEdge,
        directedDestinationEdge
    });

    if (rawNodes.length < 2) {
        throw new Error("无法沿 OSM graph 生成起点到终点的路线");
    }

    const points = sampleRouteNodes(rawNodes, sampleSpacingMeters);

    return {
        rawNodes,
        points,
        snappedStart: snappedStart.point,
        snappedDestination: snappedDestination.point,
        totalDistanceMeters: round(rawNodes.at(-1)?.distanceMeters ?? 0, 1)
    };
}

export function extendOsmRoute({
    graph,
    rawNodes,
    intent = "straight",
    intersectionCount = 2,
    stopAtFirstReachedIntersection = false,
    sampleSpacingMeters = OSM_ROUTE_SAMPLE_SPACING_METERS
}) {
    if (!graph?.nodes?.size || !Array.isArray(rawNodes) || rawNodes.length < 2) {
        throw new Error("探索路线缺少可延伸的 OSM 路网");
    }

    const nextRawNodes = rawNodes.map((node) => ({ ...node }));
    const endNodeId = nextRawNodes.at(-1)?.nodeId ?? nextRawNodes.at(-1)?.continueNodeId;
    const endNode = graph.nodes.get(endNodeId);
    if (!endNode) {
        throw new Error("当前探索路线终点无法接入 OSM 路网");
    }

    if (nextRawNodes.at(-1)?.nodeId !== endNodeId) {
        appendRouteNode(nextRawNodes, endNode, nextRawNodes.at(-1)?.edgeId ?? null);
        if (stopAtFirstReachedIntersection && (endNode.edges.length ?? 0) >= 3) {
            return {
                ...buildOsmRouteFromRawNodes(nextRawNodes, sampleSpacingMeters),
                intersectionsPassed: 1,
                edgesAdded: 1
            };
        }
    }

    let currentNodeId = endNodeId;
    let incomingHeading = getIncomingHeading(nextRawNodes);
    let intersectionsPassed = 0;
    let edgesAdded = 0;
    let returnedAtDeadEnd = false;
    let nextIntent = normalizeExplorationIntent(intent);
    const maxEdges = Math.max(20, Math.max(1, intersectionCount) * 40);

    while (intersectionsPassed < intersectionCount && edgesAdded < maxEdges) {
        let edge = chooseExplorationEdge(graph, currentNodeId, incomingHeading, nextIntent);
        if (!edge && !chooseExplorationEdge(graph, currentNodeId, incomingHeading, "straight")) {
            edge = chooseReverseExplorationEdge(graph, currentNodeId, incomingHeading);
            returnedAtDeadEnd = Boolean(edge);
        }
        if (!edge) break;

        const nextNode = graph.nodes.get(edge.to);
        if (!nextNode) break;
        appendRouteNode(nextRawNodes, nextNode, edge.id);
        currentNodeId = edge.to;
        incomingHeading = edge.heading;
        nextIntent = "straight";
        edgesAdded += 1;

        if ((graph.nodes.get(currentNodeId)?.edges.length ?? 0) >= 3) {
            intersectionsPassed += 1;
        }
    }

    if (edgesAdded === 0) {
        throw new Error("前方没有可继续探索的道路");
    }

    return {
        ...buildOsmRouteFromRawNodes(nextRawNodes, sampleSpacingMeters),
        intersectionsPassed,
        edgesAdded,
        returnedAtDeadEnd
    };
}

export function buildOsmRouteFromRawNodes(rawNodes, sampleSpacingMeters = OSM_ROUTE_SAMPLE_SPACING_METERS) {
    if (!Array.isArray(rawNodes) || rawNodes.length < 2) {
        throw new Error("OSM 路线至少需要两个路网点");
    }

    return {
        rawNodes,
        points: sampleRouteNodes(rawNodes, sampleSpacingMeters),
        totalDistanceMeters: round(rawNodes.at(-1)?.distanceMeters ?? 0, 1)
    };
}

function buildRawRouteNodes({ graph, snappedStart, snappedDestination, directedStartEdge, directedDestinationEdge }) {
    const startPoint = {
        lat: snappedStart.point.lat,
        lng: snappedStart.point.lng,
        nodeId: null,
        distanceMeters: 0,
        edgeId: directedStartEdge.id
    };

    if (isSameDirectedEdge(directedStartEdge, directedDestinationEdge)) {
        const startRatio = getSnappedRatioOnEdge(snappedStart, directedStartEdge);
        const destinationRatio = getSnappedRatioOnEdge(snappedDestination, directedDestinationEdge);
        if (destinationRatio >= startRatio) {
            return [
                startPoint,
                {
                    lat: snappedDestination.point.lat,
                    lng: snappedDestination.point.lng,
                    nodeId: null,
                    continueNodeId: directedDestinationEdge.to,
                    distanceMeters: round(haversineDistanceMeters(startPoint, snappedDestination.point), 1),
                    edgeId: directedDestinationEdge.id
                }
            ];
        }
    }

    const nextNode = graph.nodes.get(directedStartEdge.to);
    const path = findShortestPathToAnyNode(graph, directedStartEdge.to, [directedDestinationEdge.from]);
    if (!nextNode || !path) {
        return [];
    }

    const rawNodes = [
        startPoint,
        makeRouteNode(nextNode, haversineDistanceMeters(startPoint, nextNode), directedStartEdge.id)
    ];
    appendPathNodes(graph, rawNodes, path.nodeIds.slice(1), path.edgeIds);

    const previous = rawNodes.at(-1);
    rawNodes.push({
        lat: snappedDestination.point.lat,
        lng: snappedDestination.point.lng,
        nodeId: null,
        continueNodeId: directedDestinationEdge.to,
        distanceMeters: round(previous.distanceMeters + haversineDistanceMeters(previous, snappedDestination.point), 1),
        edgeId: directedDestinationEdge.id
    });

    return rawNodes;
}

function addDirectedEdge({ edges, fromNode, toNode, wayId, highway }) {
    const distanceMeters = haversineDistanceMeters(fromNode, toNode);
    if (distanceMeters < 0.5) {
        return;
    }

    const edge = {
        id: `${wayId}:${fromNode.id}:${toNode.id}`,
        wayId,
        highway,
        from: fromNode.id,
        to: toNode.id,
        fromLat: fromNode.lat,
        fromLng: fromNode.lng,
        toLat: toNode.lat,
        toLng: toNode.lng,
        distanceMeters,
        heading: bearingDegrees(fromNode, toNode)
    };
    edges.push(edge);
    fromNode.edges.push(edge);
}

function findNearestEdgePoint(point, edges) {
    const normalizedPoint = normalizeLatLng(point);
    let best = null;
    let bestDistance = Infinity;

    for (const edge of edges) {
        const projected = projectPointToSegment(
            normalizedPoint,
            { lat: edge.fromLat, lng: edge.fromLng },
            { lat: edge.toLat, lng: edge.toLng }
        );
        const distanceMeters = haversineDistanceMeters(normalizedPoint, projected.point);

        if (distanceMeters < bestDistance) {
            bestDistance = distanceMeters;
            best = {
                edge,
                point: projected.point,
                ratio: projected.ratio,
                distanceMeters
            };
        }
    }

    return best;
}

function projectPointToSegment(point, start, end) {
    const latScale = 111320;
    const lngScale = latScale * Math.cos(toRadians(point.lat));
    const px = (point.lng - start.lng) * lngScale;
    const py = (point.lat - start.lat) * latScale;
    const ex = (end.lng - start.lng) * lngScale;
    const ey = (end.lat - start.lat) * latScale;
    const lengthSquared = ex * ex + ey * ey;
    const ratio = lengthSquared === 0 ? 0 : clamp((px * ex + py * ey) / lengthSquared, 0, 1);

    return {
        ratio,
        point: {
            lat: start.lat + (end.lat - start.lat) * ratio,
            lng: start.lng + (end.lng - start.lng) * ratio
        }
    };
}

function chooseEdgeDirection(graph, edge, desiredHeading) {
    const forwardDelta = headingDelta(edge.heading, desiredHeading);
    const reverseEdge = graph.nodes.get(edge.to)?.edges.find((candidate) => (
        candidate.to === edge.from && candidate.wayId === edge.wayId
    ));
    if (!reverseEdge) {
        return edge;
    }
    const reverseDelta = headingDelta(reverseEdge.heading, desiredHeading);

    if (forwardDelta <= reverseDelta) {
        return edge;
    }

    return reverseEdge;
}

function isCyclingAllowed(tags = {}) {
    const bicycle = String(tags.bicycle ?? "").toLowerCase();
    const access = String(tags.access ?? "").toLowerCase();
    const vehicle = String(tags.vehicle ?? "").toLowerCase();
    if (bicycle === "no" || bicycle === "use_sidepath") {
        return false;
    }
    if (["yes", "designated", "permissive"].includes(bicycle)) {
        return true;
    }
    return access !== "no"
        && access !== "private"
        && vehicle !== "no"
        && vehicle !== "private";
}

function getBicycleTravelDirection(tags = {}) {
    const bicycleDirection = normalizeOnewayDirection(tags["oneway:bicycle"]);
    if (bicycleDirection) {
        return bicycleDirection;
    }

    const roadDirection = normalizeOnewayDirection(tags.oneway);
    if (roadDirection) {
        return roadDirection;
    }

    return String(tags.junction ?? "").toLowerCase() === "roundabout"
        ? "forward"
        : "both";
}

function normalizeOnewayDirection(value) {
    const normalized = String(value ?? "").toLowerCase();
    if (normalized === "-1") return "reverse";
    if (normalized === "yes" || normalized === "true" || normalized === "1") return "forward";
    if (normalized === "no" || normalized === "false" || normalized === "0") return "both";
    return null;
}

function findShortestPathToAnyNode(graph, startNodeId, targetNodeIds) {
    const targets = new Set(targetNodeIds.filter(Boolean));
    if (targets.size === 0) {
        return null;
    }

    const distances = new Map([[startNodeId, 0]]);
    const previous = new Map();
    const queue = [{ nodeId: startNodeId, distance: 0 }];
    const visited = new Set();

    while (queue.length > 0) {
        queue.sort((a, b) => a.distance - b.distance);
        const current = queue.shift();
        if (visited.has(current.nodeId)) {
            continue;
        }
        visited.add(current.nodeId);
        if (targets.has(current.nodeId)) {
            return reconstructPath(previous, current.nodeId);
        }

        const node = graph.nodes.get(current.nodeId);
        for (const edge of node?.edges ?? []) {
            const nextDistance = current.distance + edge.distanceMeters;
            if (nextDistance >= (distances.get(edge.to) ?? Infinity)) {
                continue;
            }
            distances.set(edge.to, nextDistance);
            previous.set(edge.to, {
                nodeId: current.nodeId,
                edgeId: edge.id
            });
            queue.push({ nodeId: edge.to, distance: nextDistance });
        }
    }

    return null;
}

function reconstructPath(previous, endNodeId) {
    const nodeIds = [endNodeId];
    const edgeIds = [];
    let cursor = endNodeId;

    while (previous.has(cursor)) {
        const item = previous.get(cursor);
        nodeIds.unshift(item.nodeId);
        edgeIds.unshift(item.edgeId);
        cursor = item.nodeId;
    }

    return { nodeIds, edgeIds };
}

function appendPathNodes(graph, rawNodes, nodeIds, edgeIds) {
    for (let index = 0; index < nodeIds.length; index += 1) {
        const node = graph.nodes.get(nodeIds[index]);
        const previous = rawNodes.at(-1);
        const edgeId = edgeIds[index] ?? previous?.edgeId ?? null;
        rawNodes.push(makeRouteNode(node, previous.distanceMeters + haversineDistanceMeters(previous, node), edgeId));
    }
}

function appendRouteNode(rawNodes, node, edgeId) {
    const previous = rawNodes.at(-1);
    rawNodes.push(makeRouteNode(node, previous.distanceMeters + haversineDistanceMeters(previous, node), edgeId));
}

function getIncomingHeading(rawNodes) {
    const end = rawNodes.at(-1);
    const previous = rawNodes.at(-2);
    return previous && end ? bearingDegrees(previous, end) : 0;
}

export function chooseExplorationEdge(graph, nodeId, incomingHeading, intent = "straight") {
    const candidates = (graph.nodes.get(nodeId)?.edges ?? [])
        .map((edge) => ({
            edge,
            turnAngle: signedHeadingAngle(incomingHeading, edge.heading)
        }))
        .filter(({ turnAngle }) => Math.abs(Math.abs(turnAngle) - 180) > 35);

    if (candidates.length === 0) {
        return null;
    }

    if (intent === "right") {
        return candidates
            .filter(({ turnAngle }) => turnAngle >= 25 && turnAngle <= 160)
            .sort((left, right) => Math.abs(left.turnAngle - 90) - Math.abs(right.turnAngle - 90))[0]?.edge ?? null;
    }

    if (intent === "left") {
        return candidates
            .filter(({ turnAngle }) => turnAngle <= -25 && turnAngle >= -160)
            .sort((left, right) => Math.abs(left.turnAngle + 90) - Math.abs(right.turnAngle + 90))[0]?.edge ?? null;
    }

    return candidates
        .sort((left, right) => Math.abs(left.turnAngle) - Math.abs(right.turnAngle))[0]?.edge ?? null;
}

function chooseReverseExplorationEdge(graph, nodeId, incomingHeading) {
    return (graph.nodes.get(nodeId)?.edges ?? [])
        .map((edge) => ({
            edge,
            turnAngle: Math.abs(Math.abs(signedHeadingAngle(incomingHeading, edge.heading)) - 180)
        }))
        .filter(({ turnAngle }) => turnAngle <= 35)
        .sort((left, right) => left.turnAngle - right.turnAngle)[0]?.edge ?? null;
}

function normalizeExplorationIntent(intent) {
    return ["left", "straight", "right"].includes(intent) ? intent : "straight";
}

function sampleRouteNodes(rawNodes, spacingMeters) {
    const totalDistanceMeters = rawNodes.at(-1)?.distanceMeters ?? 0;
    const sampled = [];

    for (let distance = 0; distance < totalDistanceMeters; distance += spacingMeters) {
        sampled.push(routeNodeAtDistance(rawNodes, distance));
    }
    sampled.push(routeNodeAtDistance(rawNodes, totalDistanceMeters));

    return sampled.map((point, index) => ({
        latitude: round(point.lat, 7),
        longitude: round(point.lng, 7),
        distanceMeters: round(point.distanceMeters, 1),
        elevationMeters: Number.isFinite(point.elevationMeters) ? point.elevationMeters : 0,
        gradePercent: Number.isFinite(point.gradePercent) ? point.gradePercent : 0,
        name: `OSM 轨迹点 ${index + 1}`
    }));
}

function routeNodeAtDistance(rawNodes, distanceMeters) {
    if (distanceMeters <= 0) {
        return { ...rawNodes[0], distanceMeters: 0 };
    }

    for (let index = 1; index < rawNodes.length; index += 1) {
        const previous = rawNodes[index - 1];
        const current = rawNodes[index];
        if (distanceMeters <= current.distanceMeters) {
            const segmentDistance = current.distanceMeters - previous.distanceMeters;
            const ratio = segmentDistance <= 0 ? 0 : (distanceMeters - previous.distanceMeters) / segmentDistance;

            return {
                lat: previous.lat + (current.lat - previous.lat) * ratio,
                lng: previous.lng + (current.lng - previous.lng) * ratio,
                distanceMeters
            };
        }
    }

    return rawNodes.at(-1);
}

function makeRouteNode(node, distanceMeters, edgeId) {
    return {
        lat: node.lat,
        lng: node.lng,
        nodeId: node.id,
        distanceMeters: round(distanceMeters, 1),
        edgeId
    };
}

function isSameDirectedEdge(a, b) {
    return a?.from === b?.from && a?.to === b?.to;
}

function getSnappedRatioOnEdge(snapped, edge) {
    if (snapped.edge.from === edge.from && snapped.edge.to === edge.to) {
        return snapped.ratio;
    }
    if (snapped.edge.from === edge.to && snapped.edge.to === edge.from) {
        return 1 - snapped.ratio;
    }
    return snapped.ratio;
}

export function haversineDistanceMeters(a, b) {
    const earthRadiusMeters = 6371000;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const value = Math.sin(dLat / 2) ** 2
        + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function bearingDegrees(from, to) {
    const fromLat = toRadians(from.lat);
    const toLat = toRadians(to.lat);
    const deltaLng = toRadians(to.lng - from.lng);
    const y = Math.sin(deltaLng) * Math.cos(toLat);
    const x = Math.cos(fromLat) * Math.sin(toLat)
        - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
    return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

function headingDelta(a, b) {
    const delta = Math.abs(normalizeHeading(a) - normalizeHeading(b));
    return Math.min(delta, 360 - delta);
}

function signedHeadingAngle(fromHeading, toHeading) {
    return ((toHeading - fromHeading + 540) % 360) - 180;
}

function normalizeHeading(value) {
    return ((value % 360) + 360) % 360;
}

export function normalizeLongitude(longitude) {
    return ((longitude + 540) % 360) - 180;
}

function clampLongitude(longitude) {
    return clamp(longitude, -180, 180);
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
