import process, { exit } from "process";
import { EPub, EpubContentOptions } from "@lesjoursfr/html-to-epub";
import path from "path";
import fs, { writeFile } from "fs";
import nodemailer from "nodemailer";
import RSSParser from "rss-parser";
import { Article, parseArticle } from "./article.js";
import { createHash } from "crypto";
import { ROOT_LOGGER } from "./root-logger.js";
import { ParseArgsConfig } from "node:util";
import { parseArgs } from "util";
import { buildNodemailerFromTransportConfig } from "./transport-config.js";
import assert from "assert";
import { EPub as EPubMem } from "epub-gen-memory";
import FeedParser from "feedparser";

const MOD_LOGGER = ROOT_LOGGER.child({ module: "main" });

/** Notable fields for an article from the RSS/Atom/JSON feed
 */
type FeedItem = {
    title: string;
    id: string;
    pubDate?: string;
    link?: string;
    description?: string;
};

/** Cached article entry */
type FeedCacheArticle = {
    deleted: boolean;
    feedItem: FeedItem;
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

            this._cache.articles[id] = {
                deleted: false,
                feedItem: {
                    title: item.title,
                    id: item.guid,
                    link: item.link,
                    pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
                    description: item.summary,
                },
            };
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

    async makeEpub(
        articleIds: string[],
        outPath: string,
        opts?: { title?: string; description?: string; date?: Date; author?: string | string[] },
    ) {
        // first gather all articles and their content, to make sure there's no errors
        const chapters: EpubContentOptions[] = [];
        for (const articleId of articleIds) {
            if (!this._isArticleCached(articleId)) {
                throw new Error(`no article with id "${articleId}"`);
            }

            const articleURL = this._cache.articles[articleId].feedItem.link;
            const articleFetchResponse = await fetch(articleURL, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 rss2epub/1",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            });
            if (!articleFetchResponse.ok) {
                ROOT_LOGGER.warn(
                    { httpStatusCode: articleFetchResponse.status, httpStatusMessage: articleFetchResponse.statusText },
                    "failed to fetch article",
                ); // TODO add a child logger
                continue;
            }
            const articleData = Buffer.from(await articleFetchResponse.arrayBuffer());
            const article = await parseArticle(articleData, {
                url: articleURL,
                contentType: articleFetchResponse.headers.get("Content-Type"),
            });

            try {
                chapters.push({
                    data: article.content,
                    title: article.title,
                    author: article.byline,
                });
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

            content: chapters,
        };

        // if there's one article, inherit that metadata for the ebook
        // if (articles.length == 1) {
        //     epubOptions.title ??= articles[0][0].feedItem.title;
        //     epubOptions.description ??= articles[0][0].readabilityMeta.excerpt;
        //     epubOptions.date ??= articles[0][0].feedItem.pubDate;
        //     epubOptions.author ??= articles[0][0].readabilityMeta.byline;
        // }

        epubOptions.title ??= `Article Collection, Generated ${new Date().toDateString()}`;
        epubOptions.description ??= "Included Articles:\n" + chapters.map(a => "  " + a.title).join("\n");
        epubOptions.date ??= new Date().toISOString();
        epubOptions.author ??= chapters.map(a => (Array.isArray(a.author) ? a.author.join(", ") : a.author));

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
            const epub = await this.makeEpub([articleId], epubPath);
            const filenameTitle = epub.title.replace(/[/\\:*?"'<>|]/gi, "").trim();
            await epub.render();
            await this._sendEpub(epubPath, { subject: `rss2epub: ${epub.title}`, filename: `${filenameTitle}.epub` });
            this._logSend(this._mail.to, [articleId], "SUCCESS");
        }
        this.writeCache();
    }

    async sendAllAmalgamate(opts: { cronological?: boolean; reversed?: boolean; max?: number } = {}) {
        if (!this._mail) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        const epubPath = path.join(this._directory, "temp.epub");

        let unsentArticleIds = new Array(...this.getUnsent(this._mail.to));
        if (opts.cronological) {
            unsentArticleIds.sort(
                ([_0, a1], [_1, a2]) => Date.parse(a1.feedItem.pubDate) - Date.parse(a2.feedItem.pubDate),
            );
        }

        if (opts.reversed) {
            unsentArticleIds.reverse();
        }

        if (opts.max) {
            // crop the output array to be at most opts.max elements long
            // NOTE: ORDER MATTERS HERE! it's important that this is called *after* sorting and reversing.
            unsentArticleIds = unsentArticleIds.slice(0, opts.max);
        }

        const epub = await this.makeEpub(
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

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 rss2epub/1";

async function makeEpub(
    articles: Article[],
    opts: { title?: string; description?: string; date?: Date; author?: string | string[] } = {},
): Promise<EPubMem> {
    // first gather all articles and their content, to make sure there's no errors
    const chapters = articles.map(a => ({
        content: a.content,
        title: a.title,
        author: a.byline || "Unknown",
        url: a.url,
    }));
    const epubOptions = {
        title: opts.title || `Article Collection, Generated ${new Date().toDateString()}`,
        description: opts.description || "Included Articles:\n" + chapters.map(a => "  " + a.title).join("\n"),
        date: opts.date?.toISOString() || new Date().toISOString(),
        author: opts.author || chapters.map(c => c.author).join(", "),
    };

    return new EPubMem(epubOptions, chapters);
}

type FeedSortOrder = "date";

type FetchArticlesFromFeedOpts = {
    before?: Date;
    after?: Date;
    max?: number;
    orderBy?: "date";
    reverse?: boolean;
};

const ALLOWED_CHARSET = ["ascii", "utf8", "utf-8", "utf16le", "ucs2", "ucs-2", "base64", "latin1"];

function isCharsetBufferEncoding(charset: string): charset is BufferEncoding {
    return ALLOWED_CHARSET.includes(charset);
}

function parseFeed(feedText: string): Promise<[FeedParser.Meta, FeedParser.Item[]]> {
    const logger = MOD_LOGGER.child({ op: "parseFeed" });

    const parser = new FeedParser({});

    const items: FeedParser.Item[] = [];
    let meta: undefined | FeedParser.Meta;
    parser.on("readable", function () {
        logger.trace("recieved readable event");

        let item: undefined | FeedParser.Item;
        while ((item = this.read())) {
            logger.trace({ item: { title: item.title, id: item.guid, link: item.link } }, "read item");
            items.push(item);
        }
    });
    parser.on("meta", function (m) {
        logger.trace("recieved meta event");

        meta = m;
    });

    return new Promise((accept, reject) => {
        parser.on("error", function (error) {
            logger.error(error, "recieved error event");
            reject(error);
        });
        parser.on("end", function () {
            logger.trace("recieved end event");

            assert(meta != undefined);
            accept([meta, items]);
        });
        parser.write(feedText);
        parser.end();
    });
}

async function fetchArticlesFromFeed(
    feedData: ArrayBuffer,
    contentType: string,
    opts: FetchArticlesFromFeedOpts = {},
): Promise<Article[]> {
    const logger = MOD_LOGGER.child({ op: "fetchArticlesFromFeed" });

    let charset = contentType
        .split(";")
        .filter(x => x.trim().toLowerCase().startsWith("charset="))
        .map(x => x.split("=")[1].trim())?.[0];

    if (charset) {
        logger.debug({ contentType, charset }, "feed determined charset from content type");
    } else {
        logger.debug({ contentType, charset }, "charset not in content type, using fallback");
        charset = "utf-8";
    }

    if (!isCharsetBufferEncoding(charset)) {
        logger.error({ contentType, charset, allowedCharsets: ALLOWED_CHARSET }, "charset not allowed");
        throw new Error(`charset not allowed: ${charset}`);
    }

    logger.debug({ contentType, charset }, "decoding article feed");
    const feedString = Buffer.from(feedData).toString(charset);
    let [_feedMeta, feedItems] = await parseFeed(feedString);

    if (opts.before || opts.after || opts.orderBy == "date") {
        logger.debug({ opts }, "time based option enabled, removing articles without a date");
        feedItems = feedItems.filter(x => x.date != null);
    }

    if (opts.before) {
        logger.debug({ before: opts.before }, "filtering by max date");
        feedItems = feedItems.filter(x => x.date < opts.before);
    }

    if (opts.after) {
        logger.debug({ after: opts.after }, "filtering by min date");
        feedItems = feedItems.filter(x => x.date > opts.after);
    }

    if (opts.orderBy == "date") {
        logger.debug("sorting feed by date");
        feedItems.sort((a, b) => a.date.getTime() - b.date.getTime());
    }

    if (opts.reverse) {
        logger.debug("reversing feed");
        feedItems.reverse();
    }

    if (opts.max != undefined) {
        logger.debug({ feedItemCount: feedItems.length, feedItemLimit: opts.max }, "limiting feed item count");
        feedItems = feedItems.slice(0, Math.min(opts.max, feedItems.length));
    }

    const articles: Article[] = [];
    for (const feedItem of feedItems) {
        logger.debug({ title: feedItem.title, link: feedItem.link }, "fetching feed item");
        const urlFetchResponse = await fetch(feedItem.link, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "text/html,application/xhtml+xml",
            },
        });

        if (!urlFetchResponse.ok) {
            logger.warn(
                { httpStatusCode: urlFetchResponse.status, httpStatusMessage: urlFetchResponse.statusText },
                "fetch failed",
            );
            throw new Error(`fetch '${feedItem.link}': ${urlFetchResponse.status} ${urlFetchResponse.statusText}`);
        }

        const urlContentType = urlFetchResponse.headers.get("Content-Type");
        const articleData = Buffer.from(await urlFetchResponse.arrayBuffer());
        const article = await parseArticle(articleData, {
            url: feedItem.link,
            contentType: urlContentType,
        });
        articles.push(article);
    }

    logger.debug(
        {
            articles: articles.map(a => Object.fromEntries(Object.entries(a).filter(([k, v]) => k != "content"))),
        },
        "finished building articles",
    );

    return articles;
}

/// if url points to an html page parse it as an article, if it download
async function fetchArticlesFromURL(
    url: string | URL,
    opts: { feed?: FetchArticlesFromFeedOpts } = {},
): Promise<Article[]> {
    const logger = MOD_LOGGER.child({ op: "fetchArticlesFromURL", url });
    logger.debug("fetching URL");
    const urlFetchResponse = await fetch(url, {
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/atom+xml,application/rss+xml,application/feed+json,application/xml,application/json,text/html;q=0.9,application/xhtml+xml;q=0.9",
        },
    });

    if (!urlFetchResponse.ok) {
        logger.warn(
            { httpStatusCode: urlFetchResponse.status, httpStatusMessage: urlFetchResponse.statusText },
            "fetch failed",
        ); // TODO add a child logger
        throw new Error(`fetch '${url}': ${urlFetchResponse.status} ${urlFetchResponse.statusText}`);
    }

    let urlContentType = urlFetchResponse.headers.get("Content-Type");
    if (!urlContentType) {
        logger.warn(
            {
                httpStatusCode: urlFetchResponse.status,
                httpStatusMessage: urlFetchResponse.statusText,
                responseHeaders: urlFetchResponse.headers,
            },
            "cannot determine response content type, trying 'text/html'",
        );
        urlContentType = "text/html";
    }

    const urlMimeType = urlContentType.split(";")[0].trim();

    logger.trace({ mimeType: urlMimeType, contentType: urlContentType }, "determined mime type from Content-Type");
    let articles = [];
    if (["text/html", "application/xhtml+xml"].includes(urlMimeType)) {
        logger.trace("parsing url as article");
        const articleData = Buffer.from(await urlFetchResponse.arrayBuffer());
        const article = await parseArticle(articleData, {
            url,
            contentType: urlContentType,
        });
        articles = [article];
    } else {
        logger.trace("parsing url as feed");
        articles = await fetchArticlesFromFeed(await urlFetchResponse.arrayBuffer(), urlContentType, opts?.feed || {});
    }

    logger.debug(
        {
            articles: articles.map(a => Object.fromEntries(Object.entries(a).filter(([k, v]) => k != "content"))),
        },
        "finished building articles from url",
    );

    return articles;
}

const _ARG_PARSE_CONFIG: ParseArgsConfig = {
    args: process.argv,
    strict: true,
    allowPositionals: true,
    options: {
        "transport-config": {
            type: "string",
        },
        transport: {
            type: "string",
        },
        to: {
            type: "string",
        },
        after: {
            type: "string",
        },
        max: {
            type: "string",
        },
        before: {
            type: "string",
        },
        out: {
            type: "string",
            default: "/tmp/rss2epub.epub",
        },
        order: {
            type: "string",
        },
        reverse: {
            type: "boolean",
        },
        mode: {
            type: "string",
        },
    },
};

function isFeedOrder(order: string): order is FeedSortOrder {
    return ["date"].includes(order);
}

async function main(): Promise<number> {
    const logger = ROOT_LOGGER.child({ op: "main" });
    const { values: parameters, positionals: args } = parseArgs(_ARG_PARSE_CONFIG);

    const articleURLs = args.slice(2);
    logger.trace({ parameters, args, articles: articleURLs }, "parsed command line");

    const outPath = parameters["out"];
    // TODO: check that out path is writeable?

    // basic checks on mail parameters before actually doing any work.
    if (parameters.to) {
        assert(typeof parameters.to == "string");

        if (!parameters.transport) {
            logger.error("transport must be specified to send email");
            return 1;
        }
        assert(typeof parameters.transport == "string");

        if (!parameters["transport-config"]) {
            parameters["transport-config"] = path.join(
                process.env["HOME"] || process.env["USERPROFILE"],
                ".config",
                "rss2epub",
                "transports.json",
            );
        }
        assert(typeof parameters["transport-config"] == "string");
    }

    const feedOpts: FetchArticlesFromFeedOpts = {};
    if (parameters.order) {
        assert(typeof parameters.order == "string");
        if (!isFeedOrder(parameters.order)) {
            logger.error({ parameter: "--order", value: parameters.order, expected: ["date"] }, "bad parameter");
            return 1;
        }

        feedOpts.orderBy = parameters.order;
    }

    if (parameters.reverse) {
        assert(typeof parameters.reverse == "boolean");
        feedOpts.reverse = parameters.reverse;
    }

    if (parameters.before) {
        assert(typeof parameters.before == "string");

        feedOpts.before = new Date(parameters.before);
    }

    if (parameters.after) {
        assert(typeof parameters.after == "string");
        feedOpts.after = new Date(parameters.after);
    }

    if (parameters.max) {
        assert(typeof parameters.max == "string");
        feedOpts.max = Number.parseInt(parameters.max, 10);
    }

    logger.debug({ articleURLs, outPath }, "fetching article contents");
    const allArticles: Article[] = [];
    for (const articleURL of articleURLs) {
        const articlesFromURL = await fetchArticlesFromURL(articleURL, { feed: feedOpts });
        allArticles.push(...articlesFromURL);
    }

    const title = `Article Collection, Generated ${new Date().toDateString()}`;
    const epub = await makeEpub(allArticles, { title });

    logger.debug({ articleURLs, outPath }, "rendering epub file");
    await epub.render();

    const epubBuffer = await epub.genEpub();
    if (outPath) {
        assert(typeof outPath == "string");
        await new Promise((a, r) => writeFile(outPath, epubBuffer, err => (err ? r(err) : a(null))));
    }

    if (parameters.to) {
        assert(typeof parameters.to == "string");

        if (!parameters.transport) {
            logger.error("transport must be specified to send email");
            return 1;
        }
        assert(typeof parameters.transport == "string");

        if (!parameters["transport-config"]) {
            parameters["transport-config"] = path.join(
                process.env["HOME"] || process.env["USERPROFILE"],
                ".config",
                "rss2epub",
                "transport.json",
            );
        }
        assert(typeof parameters["transport-config"] == "string");

        logger.debug({ transport: parameters.transport }, "building transport");
        const [transportOptions, transporter] = await buildNodemailerFromTransportConfig(
            parameters["transport-config"],
            parameters.transport,
        );
        const filename = "rss2epub-collection.epub";
        await transporter.sendMail({
            from: transportOptions.from,
            to: parameters.to,
            subject: `rss2epub: ${title}`,
            html: '<div dir="auto"></div>',
            attachments: [
                {
                    // stream as an attachment
                    filename,
                    content: epubBuffer,
                    contentType: "application/epub+zip",
                },
            ],
        });
    }

    logger.info({ articleURLs, outPath }, "finished building epub");
    return 0;
}

// Fetch article metadata from a list of direct article URLs or feed URLS
// function fetchArticles(url: string): ArticleMeta {
//     const articleFetchResult = await fetch(url, {
//         redirect: "follow",
//         headers: {
//             "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 rss2epub/1",
//             Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
//         },
//     });
// }

main()
    .then(code => exit(code))
    .catch(error => ROOT_LOGGER.error(error, "uncaught error from main"));
