import process from "process";
import { EPub, EpubContentOptions } from "@lesjoursfr/html-to-epub";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import RSSParser from "rss-parser";
import { parseArticle } from "./article.js";
import { createHash } from "crypto";
import { ROOT_LOGGER } from "./root-logger.js";

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
                await mailer.sendAllAmalgamate({ cronological: true, reversed: true, max: 20 });
                break;
            }
            default: {
                console.error("unknwon command '" + command + "'");
            }
        }
    }
})();
