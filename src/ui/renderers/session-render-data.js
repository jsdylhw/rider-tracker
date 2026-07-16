import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";

export function resolveSessionRenderData(state) {
    const useLiveRide = state.liveRide.isActive;
    const session = useLiveRide
        ? (state.liveRide.session ?? state.session)
        : (state.session ?? state.liveRide.session);
    const summary = useLiveRide
        ? (state.liveRide.summary ?? session?.summary ?? null)
        : (session?.summary ?? state.liveRide.summary ?? null);
    const records = useLiveRide
        ? (state.liveRide.records ?? session?.records ?? [])
        : (session?.records ?? state.liveRide.records ?? []);
    const metrics = resolveRideMetrics({
        summary,
        records,
        ftp: state.settings?.ftp ?? null
    });

    return { session, summary, records, metrics };
}
