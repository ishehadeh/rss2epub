import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import process from "process";
import { EPub } from "@lesjoursfr/html-to-epub";
import path from "path";
import fs from "fs";
import { createHash, randomUUID } from "crypto";
import nodemailer from "nodemailer";
import RSSParser from "rss-parser";
import { Resvg } from "@resvg/resvg-js";
import https from "https";

async function downloadFile(url: URL | string): Promise<Buffer> {
    console.log("downloading " + url);
    return await new Promise((resolve, reject) => {
        https
            .get(url, response => {
                const code = response.statusCode ?? 0;

                if (code >= 400) {
                    return reject(new Error(response.statusMessage));
                }

                // handle redirects
                if (code > 300 && code < 400 && response.headers.location != undefined) {
                    return resolve(downloadFile(response.headers.location));
                }

                const chunks = [];
                response.on("data", chunk => chunks.push(chunk));
                response.on("end", () => resolve(Buffer.concat(chunks)));
                response.on("error", e => reject(e));
            })
            .on("error", error => {
                reject(error);
            });
    });
}

type FitMode =
    | { mode: "original" }
    | { mode: "width"; value: number }
    | { mode: "height"; value: number }
    | { mode: "zoom"; value: number };

async function addSVGFallbacks(
    document: Document,
    pictureDir: string,
    defaultFit: FitMode = { mode: "width", value: 480 },
) {
    const images = document.querySelectorAll("img");
    for (const img of images.values()) {
        if (img.getAttribute("src").endsWith(".svg")) {
            // TODO: download fonts used in SVG
            console.log("rendering svg '" + img.getAttribute("src") + "'");
            const imageId = randomUUID(); // TODO: imageId should probably be a content has
            const imageSVGPath = path.join(pictureDir, imageId + ".svg");
            const imagePNGPath = path.join(pictureDir, imageId + ".png");

            const svgData = await downloadFile(new URL(img.getAttribute("src"), document.location.href));
            fs.writeFileSync(imageSVGPath, svgData);

            const width = img.getAttribute("width");
            const height = img.getAttribute("height");
            let fitTo = defaultFit;
            if (height != null) {
                fitTo = { mode: "height", value: Number.parseFloat(height) };
            } else if (width != null) {
                fitTo = { mode: "width", value: Number.parseFloat(width) };
            }
            const resvg = new Resvg(svgData, { fitTo });
            const raster = resvg.render();
            fs.writeFileSync(imagePNGPath, raster.asPng());

            const pictureElem = document.createElement("picture");
            const rasterImageElem = <Element>img.cloneNode();
            rasterImageElem.setAttribute("src", new URL(imagePNGPath, "file://").toString());
            const svgImageElem = document.createElement("source");
            svgImageElem.setAttribute("srcset", new URL(imageSVGPath, "file://").toString());
            pictureElem.appendChild(svgImageElem);
            pictureElem.appendChild(rasterImageElem);
            img.replaceWith(pictureElem);
        }
    }
}

/** Notable fields for an article from the RSS/Atom/JSON feed
 */
type FeedItem = {
    title: string;
    id: string;
    pubDate?: string;
    link?: string;
    description?: string;
};

/** Metadadata extracted by the reader-view implementation
 */
type ArticleMetadata = {
    title: string;
    byline: string;
    length: number;
    excerpt: string;
    siteName: string;
};

/** Cached article entry */
type FeedCacheArticle = {
    deleted: boolean;
    feedItem: FeedItem;
    readabilityMeta: ArticleMetadata;
};

type SendStatus = "FAILED" | "SUCCESS";

/** A list of attempts to send emails */
type SendLogEntry = {
    sentAt: string;
    sentTo: string;
    articlesSent: string[];
    status: SendStatus;
};

/** A map of cache ID (md5sum of link, right now) to feed entries */
type FeedCache = {
    emails: SendLogEntry[];
    articles: {
        [key: string]: FeedCacheArticle;
    };
};

type FeedMailerConfig = {
    feed: string;
    epubDir: string;
    mail?: {
        from: string;
        to: string;
        transport: nodemailer.TransportOptions;
    };
};

class FeedMailer {
    _directory: string;
    _cachePath: string;
    _cache: FeedCache;
    _feed: string;
    _mail?: {
        transport: nodemailer.Transporter;
        to: string;
        from: string;
    };

    constructor(config: FeedMailerConfig) {
        this._directory = config.epubDir;
        this._cache = {
            articles: {},
            emails: [],
        };
        this._cachePath = path.join(this._directory, ".rss2epub.json");

        if (config.mail) {
            this._mail = {
                transport: nodemailer.createTransport(config.mail.transport),
                to: config.mail.to,
                from: config.mail.from,
            };
        }

        this._feed = config.feed;
    }

    async getArticle(url: string) {
        const dom = await JSDOM.fromURL(url);
        const imgPath = path.resolve(path.join(this._directory, "img"));
        if (!fs.existsSync(imgPath)) {
            fs.mkdirSync(imgPath);
        }

        await addSVGFallbacks(dom.window.document, imgPath);
        const reader = new Readability(dom.window.document);
        return reader.parse();
    }

    readCache() {
        if (!fs.existsSync(this._directory)) {
            fs.mkdirSync(this._directory);
        }

        try {
            const cacheText = fs.readFileSync(this._cachePath, { encoding: "utf-8" });
            this._cache = Object.assign(this._cache, JSON.parse(cacheText));
        } catch (e) {
            if ("code" in e && e.code == "ENOENT") {
                // no cache file, that's fine
            } else {
                throw e;
            }
        }
    }

    writeCache() {
        if (!fs.existsSync(this._directory)) {
            fs.mkdirSync(this._directory);
        }

        fs.writeFileSync(this._cachePath, JSON.stringify(this._cache), { encoding: "utf-8" });
    }

    _getArticleById(id: string): FeedCacheArticle {
        return this._cache.articles[id];
    }

    _isArticleCached(id: string): boolean {
        return id in this._cache.articles;
    }

    async _sendEpub(epubPath: string, opts?: { subject?: string; filename?: string }) {
        if (!this._mail) {
            throw new Error(`cannot send file ${path}, no mail config`);
        }

        const filename = opts?.filename || path.basename(epubPath);
        const subject = opts?.subject || `rss2epub: ${filename}`;

        await this._mail.transport.sendMail({
            from: this._mail.from,
            to: this._mail.to,
            subject,
            html: '<div dir="auto"></div>',
            attachments: [
                {
                    // stream as an attachment
                    filename,
                    path: epubPath,
                },
            ],
        });
    }

    async downloadFeedItems() {
        this.readCache();

        const rssParser = new RSSParser();

        const feed = await rssParser.parseURL(this._feed);
        const idsInFeed = [];

        for (const item of feed.items) {
            const url = new URL(item.link);
            url.hash = "";
            const hasher = createHash("md5");
            hasher.update(url.toString());
            const id = hasher.digest().toString("hex");

            idsInFeed.push(id);
            if (this._getArticleById(id) != undefined) {
                // TODO check for collision
                console.log(`skipping ${item.link}, exists in cache)`);
                continue;
            }

            const articleFile = path.join(this._directory, id + ".html");
            try {
                const article = await this.getArticle(item.link);
                fs.writeFileSync(articleFile, article.content);
                this._cache.articles[id] = {
                    deleted: false,
                    feedItem: {
                        title: item.title,
                        id: item.guid,
                        link: item.link,
                        pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
                        description: item.summary,
                    },
                    readabilityMeta: {
                        title: article.title,
                        byline: article.byline,
                        length: article.length,
                        excerpt: article.excerpt,
                        siteName: article.siteName,
                    },
                };
            } catch (e) {
                console.error(`failed to parse article '${item.title}': ${e}`);
                continue;
            }
        }

        for (const id in this._cache.articles) {
            if (!idsInFeed.includes(id)) {
                this._getArticleById(id).deleted = true;
            }
        }

        this.writeCache();
    }

    getSentArtcleIds(to?: string): string[] {
        return this._cache.emails
            .filter(e => e.status == "SUCCESS" && (!to || e.sentTo == to))
            .flatMap(e => e.articlesSent);
    }

    getUnsent(to?: string): Iterable<[string, FeedCacheArticle]> {
        const sent = this.getSentArtcleIds(to);
        return Object.entries(this._cache.articles).filter(([id, _a]) => !sent.includes(id));
    }

    makeEpub(
        articleIds: string[],
        outPath: string,
        opts?: { title?: string; description?: string; date?: Date; author?: string | string[] },
    ) {
        // first gather all articles and their content, to make sure there's no errors
        const articles: [FeedCacheArticle, string][] = [];
        for (const articleId of articleIds) {
            if (!this._isArticleCached(articleId)) {
                throw new Error(`no article with id "${articleId}"`);
            }

            try {
                const content = fs.readFileSync(path.join(this._directory, `${articleId}.html`), { encoding: "utf-8" });
                articles.push([this._getArticleById(articleId), content]);
            } catch (e) {
                if ("code" in e && e.code == "ENOENT") {
                    throw new Error(`bad cache: article has entry, but no corrosponding content. id="${articleId}"`);
                } else {
                    throw e;
                }
            }
        }

        const epubOptions = {
            title: opts?.title,
            description: opts?.description,
            date: opts?.date?.toISOString(),
            author: opts?.author,

            content: articles.map(([a, content]) => ({ title: a.feedItem.title, data: content })),
        };

        // if there's one article, inherit that metadata for the ebook
        if (articles.length == 1) {
            epubOptions.title ??= articles[0][0].feedItem.title;
            epubOptions.description ??= articles[0][0].readabilityMeta.excerpt;
            epubOptions.date ??= articles[0][0].feedItem.pubDate;
            epubOptions.author ??= articles[0][0].readabilityMeta.byline;
        }

        epubOptions.title ??= `Article Collection, Generated ${new Date().toDateString()}`;
        epubOptions.description ??= "Included Articles:\n" + articles.map(a => a[0].feedItem.title).join("\n");
        epubOptions.date ??= new Date().toISOString();
        epubOptions.author ??= articles.map(a => a[0].readabilityMeta.byline);

        return new EPub(epubOptions, outPath);
    }

    _logSend(to: string, articles: string[], status: "SUCCESS" | "FAILED") {
        this._cache.emails.push({
            sentAt: new Date().toISOString(),
            sentTo: to,
            articlesSent: articles,
            status,
        });
    }

    async sendAllIndividual() {
        if (!this._mail) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        const epubPath = path.join(this._directory, "temp.epub");
        for (const [articleId, _article] of this.getUnsent(this._mail.to)) {
            const epub = this.makeEpub([articleId], epubPath);
            const filenameTitle = epub.title.replace(/[/\\:*?"'<>|]/gi, "").trim();
            await epub.render();
            await this._sendEpub(epubPath, { subject: `rss2epub: ${epub.title}`, filename: `${filenameTitle}.epub` });
            this._logSend(this._mail.to, [articleId], "SUCCESS");
        }
        this.writeCache();
    }

    async sendAllAmalgamate(opts: { cronological?: boolean; reversed?: boolean } = {}) {
        if (!this._mail) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        const epubPath = path.join(this._directory, "temp.epub");
        const unsentArticleIds = new Array(...this.getUnsent(this._mail.to));
        if (opts.cronological) {
            unsentArticleIds.sort(
                ([_0, a1], [_1, a2]) => Date.parse(a1.feedItem.pubDate) - Date.parse(a2.feedItem.pubDate),
            );
        }

        if (opts.reversed) {
            unsentArticleIds.reverse();
        }

        const epub = this.makeEpub(
            unsentArticleIds.map(([id, _]) => id),
            epubPath,
        );
        const filenameTitle = epub.title.replace(/[/\\:*?"'<>|]/gi, "").trim();
        await epub.render();
        await this._sendEpub(epubPath, { subject: `rss2epub: ${epub.title}`, filename: `${filenameTitle}.epub` });

        this._logSend(
            this._mail.to,
            unsentArticleIds.map(([id, _]) => id),
            "SUCCESS",
        );

        this.writeCache();
    }
}

(async () => {
    const config: FeedMailerConfig = JSON.parse(fs.readFileSync(process.argv[2], { encoding: "utf-8" }));
    const mailer = new FeedMailer(config);
    for (let argi = 3; argi < process.argv.length; ++argi) {
        const command = process.argv[argi];
        switch (command) {
            case "sync": {
                await mailer.downloadFeedItems();
                break;
            }
            case "send-indiviudal": {
                await mailer.sendAllIndividual();
                break;
            }
            case "send-amalgamate": {
                await mailer.sendAllAmalgamate({ cronological: true, reversed: true });
                break;
            }
            default: {
                console.error("unknwon command '" + command + "'");
            }
        }
    }
})();
