import { ROOT_LOGGER } from "./root-logger.js";
import { JSDOM, SupportedContentTypes } from "jsdom";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import { Readability } from "@mozilla/readability";
import { createHash } from "crypto";

const LOGGER = ROOT_LOGGER.child({ module: "article" });

export const SUPPORTED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

export type Article = {
    title: string;
    byline?: string;
    length: number;
    excerpt: string;
    siteName: string;
    url: string;
    content: string;
};

export type FitMode =
    | { mode: "original" }
    | { mode: "width"; value: number }
    | { mode: "height"; value: number }
    | { mode: "zoom"; value: number };

export type SVGOptions = {
    imageDir: string;
    defaultFit: FitMode;
};

export type GetArticleOptions = {
    url: URL | string;
    contentType?: string;
    renderSVG?: SVGOptions;
};

function isSupportedContentType(contentType: undefined | string): contentType is SupportedContentTypes {
    // JSDOM actually supports more content types than SUPPORTED_CONTENT_TYPES, but SUPPORTED_CONTENT_TYPES is the subset that makes sense for our use-case.
    return contentType != undefined && SUPPORTED_CONTENT_TYPES.includes(contentType.split(";")[0]);
}

export async function parseArticle(html: Buffer, opts: GetArticleOptions): Promise<Article> {
    const strURL = opts.url.toString();
    const logger = LOGGER.child({ url: strURL, op: "parseArticle" });
    if (!isSupportedContentType(opts.contentType)) {
        logger.warn(
            { contentType: opts.contentType, supportedContentTypes: SUPPORTED_CONTENT_TYPES },
            "unsupported content type passed to parseArtcle()",
        );

        throw new Error(`unsupported content type: '${opts.contentType}'`);
    }

    logger.trace("parsing article HTML");
    const dom = new JSDOM(html, { contentType: opts.contentType, url: strURL });

    if (opts.renderSVG != undefined) {
        const imgPath = path.resolve(opts.renderSVG.imageDir);
        logger.trace({ imageDirectory: imgPath }, "rendering SVG images");

        if (!existsSync(imgPath)) {
            mkdirSync(imgPath);
        }

        await addSVGFallbacks(dom.window.document, imgPath, opts.renderSVG.defaultFit);
    }

    logger.trace("reformatting article with readability");
    const reader = new Readability(dom.window.document);
    const readerArticle = reader.parse();
    return {
        title: readerArticle.title,
        byline: readerArticle.byline,
        length: readerArticle.length,
        excerpt: readerArticle.excerpt,
        siteName: readerArticle.siteName,
        url: opts.url.toString(),
        content: readerArticle.content,
    };
}

async function addSVGFallbacks(
    document: Document,
    pictureDir: string,
    defaultFit: FitMode = { mode: "width", value: 480 },
) {
    const logger = LOGGER.child({ url: document.location.href, op: "addSVGFallbacks" });

    const images = document.querySelectorAll("img");
    for (const img of images.values()) {
        const src = img.getAttribute("src");
        if (src.endsWith(".svg")) {
            // TODO: download fonts used in SVG
            const span = logger.child({ src });

            span.trace("downloading SVG image");
            const svgFetchResponse = await fetch(document.location.href, { redirect: "follow" });
            if (!svgFetchResponse.ok) {
                logger.warn(
                    { httpStatusCode: svgFetchResponse.status, httpStatusMessage: svgFetchResponse.statusText },
                    "failed to fetch SVG",
                );
                // TODO maybe make this configurable, or replace the image with a broken image image
                continue;
            }
            if (svgFetchResponse.headers.get("Content-Type").split(";")[0] != "image/svg+xml") {
                logger.warn(
                    { contentType: svgFetchResponse.headers.get("Content-Type"), expectedContentType: "image/svg+xml" },
                    "unexpected SVG content type",
                );
            }

            const svgData = Buffer.from(await svgFetchResponse.arrayBuffer());

            const svgContentHash = createHash("sha256");
            svgContentHash.update(svgData);
            const imageId = svgContentHash.digest("hex");

            const imageSVGPath = path.join(pictureDir, imageId + ".svg");
            const imagePNGPath = path.join(pictureDir, imageId + ".png");

            span.trace({ path: imageSVGPath }, "caching SVG");
            writeFileSync(imageSVGPath, svgData);

            const width = img.getAttribute("width");
            const height = img.getAttribute("height");
            let fitTo = defaultFit;
            if (height != null) {
                logger.debug({ width, height }, "using height fit mode");
                fitTo = { mode: "height", value: Number.parseFloat(height) };
            } else if (width != null) {
                logger.debug({ width, height }, "using width fit mode");
                fitTo = { mode: "width", value: Number.parseFloat(width) };
            }
            const resvg = new Resvg(svgData, { fitTo });

            logger.debug({ width, height, fitTo }, "rendering SVG");
            const raster = resvg.render();

            span.trace({ path: imagePNGPath }, "caching raster image");
            writeFileSync(imagePNGPath, raster.asPng());

            const rasterURI = new URL(imagePNGPath, "file://");
            const vectorURI = new URL(imageSVGPath, "file://");
            span.debug({ images: [rasterURI, vectorURI] }, "replacing <img> with <picture> set");

            const pictureElem = document.createElement("picture");

            const rasterImageElem = <Element>img.cloneNode();
            rasterImageElem.setAttribute("src", rasterURI.toString());

            const svgImageElem = document.createElement("source");
            svgImageElem.setAttribute("srcset", vectorURI.toString());

            pictureElem.appendChild(svgImageElem);
            pictureElem.appendChild(rasterImageElem);
            img.replaceWith(pictureElem);
        }
    }
}
