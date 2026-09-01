import { createRouteNarrationRenderer } from "../../src/ui/renderers/route-narration-renderer.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

function createElements() {
    return {
        routeNarrationHudCard: createFakeElement(),
        routeNarrationStatus: createFakeElement(),
        routeNarrationTitle: createFakeElement(),
        routeNarrationSummary: createFakeElement(),
        routeNarrationMedia: createFakeElement(),
        routeNarrationPhoto: createFakeElement(),
        routeNarrationPhotoCredit: createFakeElement(),
        routeNarrationPosition: createFakeElement(),
        routeNarrationCloseBtn: createFakeElement(),
        routeNarrationLoadBtn: createFakeElement(),
        routeNarrationRetryBtn: createFakeElement(),
        routeNarrationPreviousBtn: createFakeElement(),
        routeNarrationNextBtn: createFakeElement()
    };
}

function createState() {
    return {
        status: "partial",
        item: {
            title: "屋岛",
            summary: "濑户内海沿岸的演示讲解。",
            media: {
                type: "google_place_photo",
                photo_name: "places/place_1/photos/photo_1",
                author_attributions: [{
                    display_name: "测试摄影者",
                    uri: "https://maps.google.test/author"
                }]
            }
        },
        itemIndex: 1,
        itemCount: 5,
        distanceToItemMeters: 260,
        canMovePrevious: true,
        canMoveNext: true,
        isAnnounced: false,
        plan: { content_profile: "fixture" }
    };
}

export const suite = {
    name: "route-narration-renderer",
    tests: [
        {
            name: "shows consent before any narration request",
            run() {
                const elements = createElements();
                let loaded = false;
                let closed = false;
                const renderer = createRouteNarrationRenderer({
                    elements,
                    onLoad: () => { loaded = true; },
                    onClose: () => { closed = true; }
                });
                renderer.render({ status: "prompt" }, { visible: true });
                assertEqual(elements.routeNarrationHudCard.hidden, false);
                assertEqual(elements.routeNarrationTitle.textContent, "加载沿途讲解？");
                assertEqual(elements.routeNarrationLoadBtn.hidden, false);
                elements.routeNarrationLoadBtn.dispatch("click");
                elements.routeNarrationCloseBtn.dispatch("click");
                assertEqual(loaded, true);
                assertEqual(closed, true);
            }
        },
        {
            name: "renders safe text and navigation state in the immersive HUD",
            run() {
                const elements = createElements();
                const actions = [];
                const renderer = createRouteNarrationRenderer({
                    elements,
                    onPrevious: () => actions.push("previous"),
                    onNext: () => actions.push("next")
                });
                renderer.render(createState(), { visible: true });
                assertEqual(elements.routeNarrationHudCard.hidden, false);
                assertEqual(elements.routeNarrationTitle.textContent, "屋岛");
                assertEqual(elements.routeNarrationSummary.textContent, "濑户内海沿岸的演示讲解。");
                assertEqual(elements.routeNarrationStatus.textContent, "路线讲解 · 前方 260 m");
                assertEqual(elements.routeNarrationPosition.textContent, "2 / 5");
                assertEqual(elements.routeNarrationMedia.hidden, false);
                assertEqual(elements.routeNarrationPhoto.src.includes("places%2Fplace_1%2Fphotos%2Fphoto_1"), true);
                assertEqual(elements.routeNarrationPhotoCredit.textContent, "照片：测试摄影者");
                assertEqual(elements.routeNarrationPhotoCredit.attributes.href, "https://maps.google.test/author");
                elements.routeNarrationPreviousBtn.dispatch("click");
                elements.routeNarrationNextBtn.dispatch("click");
                assertEqual(actions.join(","), "previous,next");
                elements.routeNarrationPhoto.dispatch("error");
                renderer.render(createState(), { visible: true });
                assertEqual(elements.routeNarrationMedia.hidden, true);
            }
        },
        {
            name: "shows a reachable retry action after preparation failure",
            run() {
                const elements = createElements();
                let retried = false;
                const renderer = createRouteNarrationRenderer({
                    elements,
                    onRetry: () => { retried = true; }
                });
                renderer.render({ status: "failed", error: "provider unavailable" }, { visible: true });
                assertEqual(elements.routeNarrationHudCard.hidden, false);
                assertEqual(elements.routeNarrationTitle.textContent, "讲解准备失败");
                assertEqual(elements.routeNarrationSummary.textContent, "provider unavailable");
                assertEqual(elements.routeNarrationRetryBtn.hidden, false);
                elements.routeNarrationRetryBtn.dispatch("click");
                assertEqual(retried, true);
            }
        },
        {
            name: "stays hidden outside immersive Street View",
            run() {
                const elements = createElements();
                const renderer = createRouteNarrationRenderer({ elements });
                renderer.render(createState(), { visible: false });
                assertEqual(elements.routeNarrationHudCard.hidden, true);
            }
        },
        {
            name: "shows narration capability degradation without blocking Street View",
            run() {
                const elements = createElements();
                const renderer = createRouteNarrationRenderer({ elements });
                renderer.render({ status: "prompt" }, {
                    visible: true,
                    agentCapabilities: {
                        backend: "available", llm: "not_configured",
                        capabilities: { route_narration: false }
                    }
                });

                assertEqual(elements.routeNarrationHudCard.hidden, false);
                assertEqual(elements.routeNarrationTitle.textContent, "沿途讲解未启用");
                assertEqual(elements.routeNarrationSummary.textContent.includes("街景和骑行不受影响"), true);
                assertEqual(elements.routeNarrationLoadBtn.hidden, true);
            }
        }
    ]
};
