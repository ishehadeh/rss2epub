import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import process from "process";
import { EPub } from "@lesjoursfr/html-to-epub";
import FeedExtractor from "@extractus/feed-extractor";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import nodemailer from "nodemailer";

// try to make all img src that fail to parse as a URL relative to `base`
function makeImageSrcsAbsolute(document, base) {
    const images = document.querySelectorAll("img");
    for (const image of images) {
        try {
            const _url = new URL(image.src);
        } catch (e) {
            if (e instanceof TypeError && e.name == "ERR_INVALID_URL") {
                const url = new URL(image.src, base);
                console.log(`fixing image url: ${image.src} -> ${url}`);
                image.src = url.toString();
            } else {
                throw e;
            }
        }
    }
}

async function getArticle(url) {
    const dom = await JSDOM.fromURL(url);
    makeImageSrcsAbsolute(dom.window.document, url);
    const reader = new Readability(dom.window.document);
    return reader.parse();
}

type FeedItem = {
    title: string;
    id: string;
    pubDate?: Date;
    link?: string;
    description?: string;
};

type FeedCacheArticle = {
    sentTo: string[];
    deleted: boolean;
    feedItem?: FeedItem;
    readabilityMeta?: {
        title: string;
        byline: string;
        length: number;
        excerpt: string;
        siteName: string;
    };
};

type FeedCache = {
    [key: string]: FeedCacheArticle;
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
        this._cache = {};
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

    articleSent(articleId: string): boolean {
        return articleId in this._cache && this._cache[articleId].sentTo.indexOf(this._mail.to) >= 0;
    }

    async downloadFeedItems() {
        this.readCache();

        const feed = await FeedExtractor.extract(this._feed);
        const idsInFeed = [];

        for (const item of feed.entries || []) {
            const url = new URL(item.link);
            url.hash = "";
            const hasher = createHash("md5");
            hasher.update(url.toString());
            const id = hasher.digest().toString("hex");

            idsInFeed.push(id);
            if (id in this._cache) {
                console.log(`skipping ${item.link}, exists in cache)`);
                continue;
            }

            const articleFile = path.join(this._directory, id + ".html");
            try {
                const article = await getArticle(item.link);
                fs.writeFileSync(articleFile, article.content);
                this._cache[id] = {
                    sentTo: [],
                    deleted: false,
                    feedItem: {
                        title: item.title,
                        id: item.id,
                        link: item.link,
                        pubDate: item.published,
                        description: item.description,
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

        for (const id in this._cache) {
            if (!idsInFeed.includes(id)) {
                this._cache[id].deleted = true;
            }
        }

        this.writeCache();
    }

    getUnsent(to?: string): Iterable<[string, FeedCacheArticle]> {
        return Object.entries(this._cache).filter(
            ([_, a]) => !a.deleted && (to != undefined || !a.sentTo.includes(to)),
        );
    }

    makeEpub(
        articleIds: string[],
        outPath: string,
        opts?: { title?: string; description?: string; date?: Date; author?: string | string[] },
    ) {
        // first gather all articles and their content, to make sure there's no errors
        const articles: [FeedCacheArticle, string][] = [];
        for (const articleId of articleIds) {
            if (!(articleId in this._cache)) {
                throw new Error(`no article with id "${articleId}"`);
            }

            try {
                const content = fs.readFileSync(path.join(this._directory, `${articleId}.html`), { encoding: "utf-8" });
                articles.push([this._cache[articleId], content]);
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
            epubOptions.date ??= articles[0][0].feedItem.pubDate.toISOString();
            epubOptions.author ??= articles[0][0].readabilityMeta.byline;
        }

        epubOptions.title ??= `Article Collection, Generated ${new Date().toDateString()}`;
        epubOptions.description ??= "Included Articles:\n" + articles.map(a => a[0].feedItem.title).join("\n");
        epubOptions.date ??= new Date().toISOString();
        epubOptions.author ??= articles.map(a => a[0].readabilityMeta.byline);

        return new EPub(epubOptions, outPath);
    }

    async sendAllIndividual() {
        if (!this._mail) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        const epubPath = path.join(this._directory, "temp.epub");
        for (const [articleId, article] of this.getUnsent(this._mail.to)) {
            const epub = this.makeEpub([articleId], epubPath);
            const filenameTitle = epub.title.replace(/[/\\:*?"'<>|]/gi, "").trim();
            await epub.render();
            await this._sendEpub(epubPath, { subject: `rss2epub: ${epub.title}`, filename: `${filenameTitle}.epub` });
            article.sentTo.push(this._mail.to);
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
                ([_0, a1], [_1, a2]) => a1.feedItem.pubDate?.getTime() ?? 0 - a2.feedItem.pubDate?.getTime() ?? 0,
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
        unsentArticleIds.forEach(([_, a]) => a.sentTo.push(this._mail.to));

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
