import {
    GPX_MIME_TYPE,
    routeGpxFileName,
    serializeRouteToGpx
} from "../../domain/route/gpx-exporter.js";

export function downloadRouteAsGpx(route, {
    documentRef = globalThis.document,
    urlApi = globalThis.URL,
    BlobType = globalThis.Blob
} = {}) {
    if (!documentRef?.createElement || !urlApi?.createObjectURL || !BlobType) {
        throw new Error("当前环境不支持下载 GPX 文件。");
    }

    const xml = serializeRouteToGpx(route);
    const fileName = routeGpxFileName(route);
    const blob = new BlobType([xml], { type: GPX_MIME_TYPE });
    const objectUrl = urlApi.createObjectURL(blob);
    const anchor = documentRef.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.hidden = true;

    try {
        documentRef.body?.appendChild?.(anchor);
        anchor.click();
    } finally {
        anchor.remove?.();
        urlApi.revokeObjectURL?.(objectUrl);
    }

    return { fileName, sizeBytes: blob.size };
}
