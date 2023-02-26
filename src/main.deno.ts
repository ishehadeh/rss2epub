import { Readability } from "https://cdn.skypack.dev/@mozilla/readability";
import { parseHTML } from "https://esm.sh/linkedom";
import process from "node:process";
import EPub from "https://deno.land/x/epubgen/mod.ts";
import { parseFeed } from "https://deno.land/x/rss/mod.ts";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { SMTPClient } from "https://deno.land/x/denomailer/mod.ts";

async function getArticle(url: string | URL) {
    console.log(url);
    const response = await fetch(url);
    const documentText = await response.text();
    const window = parseHTML(documentText, { location: { href: url } });

    const reader = new Readability(window.document);
    return reader.parse();
}

type FeedCacheArticle = {
    sentTo: string[];
    deleted: boolean;
    feedItem: {
        id: string;
        title: string;
        link?: string;
        description?: string;
        date: Date;
        content?: {
            type: string;
            data: string;
        };
    };
    readabilityMeta: {
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

type MailTransportConfig = {
    hostname: string;
    port?: number;
    auth?: {
        user: string;
        pass: string;
    };
    tls?: boolean;
};

type FeedMailerConfig = {
    feed: string;
    epubDir: string;
    mail?: {
        from: string;
        to: string;
        transport: MailTransportConfig;
    };
};

class FeedMailer {
    _directory: string;
    _cachePath: string;
    _cache: FeedCache;
    _feed: string;
    _mail?: {
        transport: SMTPClient;
        to: string;
        from: string;
    };

    constructor(config: FeedMailerConfig) {
        this._directory = config.epubDir;
        this._cache = {};
        this._cachePath = path.join(this._directory, ".rss2epub.json");

        if (config.mail) {
            const conn = config.mail.transport;
            console.log(conn);
            this._mail = {
                transport: new SMTPClient({
                    connection: {
                        tls: conn.tls,
                        port: conn.port,
                        hostname: conn.hostname,
                        auth: conn.auth ? { username: conn.auth.user, password: conn.auth.pass } : undefined,
                    },
                }),
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

    async _sendEpub(epubData: Uint8Array, opts?: { subject?: string; filename?: string }) {
        if (!this._mail) {
            throw new Error(`cannot send file ${path}, no mail config`);
        }

        const filename = opts?.filename || "book.epub";
        const subject = opts?.subject || `rss2epub: ${filename}`;

        await this._mail.transport.send({
            from: this._mail.from,
            to: this._mail.to,
            subject,
            html: '<div dir="auto"></div>',
            attachments: [
                {
                    // stream as an attachment
                    filename,
                    contentType: "application/epub+zip",
                    encoding: "binary",
                    content: epubData,
                },
            ],
        });
    }

    articleSent(articleId: string): boolean {
        return (
            articleId in this._cache &&
            this._mail != undefined &&
            this._cache[articleId].sentTo.indexOf(this._mail.to) >= 0
        );
    }

    async downloadFeedItems() {
        this.readCache();

        const feedText = await fetch(this._feed).then(r => r.text());
        const feed = await parseFeed(feedText);
        const idsInFeed = [];

        for (const item of feed.entries) {
            const feedInfo = {
                id: item.id,
                title: item.title?.value || "Untitled",
                link: item.links.filter(l => l.href != undefined)[0]?.href,
                description: item.description?.value,
                date: item.published || new Date(),
                content: item.content?.value
                    ? {
                          type: item.content.type || "text/plain",
                          data: item.content.value,
                      }
                    : undefined,
            };
            if (!feedInfo.link && !feedInfo.content) {
                console.log(`${feedInfo.title} (${feedInfo.id}): No link or content, skipping`);
                continue;
            }

            // TODO: use content as aritcle if no link
            if (!feedInfo.link) {
                console.log(
                    `${feedInfo.title} (${feedInfo.id}): No link, extracting content is unimplemented, skipping`,
                );
                continue;
            }

            const url = new URL(item.id);
            url.hash = "";
            const hasher = createHash("md5");
            hasher.update(feedInfo.id);
            const id = hasher.digest().toString("hex");

            idsInFeed.push(id);
            if (id in this._cache) {
                console.log(`skipping ${feedInfo.title} (${id}), exists in cache)`);
                continue;
            }

            const articleFile = path.join(this._directory, id + ".html");
            try {
                const article = await getArticle(feedInfo.link);
                fs.writeFileSync(articleFile, article.content);
                this._cache[id] = {
                    sentTo: [],
                    deleted: false,
                    feedItem: feedInfo,
                    readabilityMeta: {
                        title: article.title,
                        byline: article.byline,
                        length: article.length,
                        excerpt: article.excerpt,
                        siteName: article.siteName,
                    },
                };
            } catch (e) {
                console.error(`failed to parse article '${item.title?.value}': ${e}`);
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
            ([_, a]) => !a.deleted && (to == undefined || !a.sentTo.includes(to)),
        );
    }

    async makeEpub(
        articleIds: string[],
        opts?: { title?: string; description?: string; date?: Date; author?: string },
    ): Promise<{
        title: string;
        description: string;
        date: string;
        author: string;
        file: Uint8Array;
    }> {
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

        let title = opts?.title;
        let description = opts?.description;
        let date = opts?.date?.toISOString();
        let author = opts?.author;

        // if there's one article, inherit that metadata for the ebook
        if (articles.length == 1) {
            title ??= articles[0][0].feedItem.title;
            description ??= articles[0][0].readabilityMeta.excerpt;
            date ??= articles[0][0].feedItem.date.toISOString();
            author ??= articles[0][0].readabilityMeta.byline;
        }

        title = `Article Collection, Generated ${new Date().toDateString()}`;
        description ??= "Included Articles:\n" + articles.map(a => a[0].feedItem.title).join("\n");
        date ??= new Date().toISOString();
        author ??= articles.map(a => a[0].readabilityMeta.byline).join(", ");

        const epubOptions = { title, description, date, author };
        return {
            ...epubOptions,
            file: await EPub(
                epubOptions,
                articles.map(([a, content]) => ({ title: a.feedItem.title, content })),
            ),
        };
    }

    async sendAllIndividual() {
        if (!this._mail) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        const epubPath = path.join(this._directory, "temp.epub");
        for (const [articleId, article] of this.getUnsent(this._mail.to)) {
            const epub = await this.makeEpub([articleId], epubPath);
            const filenameTitle = epub.title.replace(/[/\\:*?"'<>|]/gi, "").trim();
            await this._sendEpub(epubPath, { subject: `rss2epub: ${epub.title}`, filename: `${filenameTitle}.epub` });
            article.sentTo.push(this._mail.to);
        }
        this.writeCache();
    }

    async sendAllAmalgamate(opts: { cronological?: boolean; reversed?: boolean } = {}) {
        if (this._mail == undefined) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        // const epubPath = path.join(this._directory, "temp.epub");
        const unsentArticleIds = new Array(...this.getUnsent(this._mail.to));
        if (opts.cronological) {
            unsentArticleIds.sort(
                ([_0, a1], [_1, a2]) => Date.parse(a1.feedItem.isoDate) - Date.parse(a2.feedItem.isoDate),
            );
        }

        if (opts.reversed) {
            unsentArticleIds.reverse();
        }

        const epub = await this.makeEpub(unsentArticleIds.map(([id, _]) => id));
        const filenameTitle = epub.title.replace(/[/\\:*?"'<>|]/gi, "").trim();
        await this._sendEpub(epub.file, { subject: `rss2epub: ${epub.title}`, filename: `${filenameTitle}.epub` });
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
