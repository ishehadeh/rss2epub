import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import process from 'process';
import { EPub } from '@lesjoursfr/html-to-epub';
import RSSParser from 'rss-parser';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import nodemailer from 'nodemailer';

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
    return reader.parse()
}

async function epubFromArticles(title, articles, path) {
    let options = {
        title,
        verbose: true,
        author: "article2epub",
        description: "",
        content: articles.map(a => ({ title: a.title, author: a.author, data: a.content }))
    }

    return new EPub(options, path)
}


async function rssToEpub(url, outPath) {
    const feedParser = new RSSParser();
    const feed = await feedParser.parseURL(url);
    let articles = [];
    for (const item of feed.items) {
        try {
            articles.push(await getArticle(item.link));
        } catch (e) {
            console.error(`failed to parse article '${item.title}': ${e}`);
        }
    }
    const epub = await epubFromArticles(feed.title, articles, outPath);
    await epub.render();
    return epub;
}

async function rssToEpubSeparate(url, outDir) {
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir);
    }

    const feedParser = new RSSParser();
    const feed = await feedParser.parseURL(url);
    for (const item of feed.items) {
        let url = new URL(item.link);
        url.hash = "";
        const hasher = createHash('md5');
        hasher.update(url.toString());
        const filename = hasher.digest().toString('hex');
        const epubFile = path.join(outDir, filename + ".epub");
        if (fs.existsSync(epubFile)) {
            console.log(`skipping ${item.link}, already converted (${filename}.epub)`);
            continue;
        }

        try {
            const article = await getArticle(item.link);
            let options = {
                title: article.title,
                author: article.byline,
                description: article.excerpt,
                // date: new Date(item.pubDate),
                content: [{ title: article.title, data: article.content }]
            }

            let epub = new EPub(options, epubFile);
            await epub.render();
        } catch (e) {
            console.error(`failed to parse article '${item.title}': ${e}`);
            continue;
        }

    }
}

type FeedCacheArticle = {
    sentTo: string[];
    feedItem?: RSSParser.Item;
};

type FeedCache = {
    [key: string]: FeedCacheArticle
};

type FeedMailerConfig = {
    feed: string,
    epubDir: string,
    mail?: {
        from: string,
        to: string,
        transport: nodemailer.TransportOptions,
    }
};

class FeedMailer {

    _directory: string
    _cachePath: string
    _cache: FeedCache
    _feed: string
    _mail?: {
        transport: nodemailer.Transporter
        to: string
        from: string
    }

    constructor(config: FeedMailerConfig) {
        this._directory = config.epubDir;
        this._cache = {};
        this._cachePath = path.join(this._directory, ".rss2epub.json");

        if (config.mail) {
            this._mail = {
                transport: nodemailer.createTransport(config.mail.transport),
                to: config.mail.to,
                from: config.mail.from
            }
        }

        this._feed = config.feed;
    }

    readCache() {
        if (!fs.existsSync(this._directory)) {
            fs.mkdirSync(this._directory);
        }

        try {
            const cacheText = fs.readFileSync(this._cachePath, { encoding: 'utf-8' })
            this._cache = Object.assign(this._cache, JSON.parse(cacheText));
        } catch (e) {
            if ('code' in e && e.code == "ENOENT") {
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

    async sendArticle(id: string) {
        if (!this._mail) {
            throw new Error(`cannot send article ${id}, no mail config`);
        }

        let subject = `rss2epub Article ${id}`;
        if (id in this._cache && this._cache[id].feedItem) {
            subject = `rss2epub: ${this._cache[id].feedItem.title}` || subject;
        }

        await this._mail.transport.sendMail({
            from: this._mail.from,
            to: this._mail.to,
            subject,
            html: "<div dir=\"auto\"></div>",
            attachments: [{   // stream as an attachment
                filename: `${id}.epub`,
                path: path.join(this._directory, `${id}.epub`)
            }]
        });

        if (!(id in this._cache)) {
            this._cache[id] = { sentTo: [] };
        }
        this._cache[id].sentTo.push(this._mail.to);
        this.writeCache();

    }

    articleSent(articleId: string): boolean {
        return articleId in this._cache && this._cache[articleId].sentTo.indexOf(this._mail.to) >= 0;
    }

    async downloadFeedItems() {
        this.readCache()

        const feedParser = new RSSParser();
        const feed = await feedParser.parseURL(this._feed);
        for (const item of feed.items) {
            let url = new URL(item.link);
            url.hash = "";
            const hasher = createHash('md5');
            hasher.update(url.toString());
            const id = hasher.digest().toString('hex');

            if (!(id in this._cache)) {
                this._cache[id] = { sentTo: [] }
            }
            // TODO check for hash collisions
            this._cache[id].feedItem = item;

            const epubFile = path.join(this._directory, id + ".epub");
            if (fs.existsSync(epubFile)) {
                console.log(`skipping ${item.link}, already converted (${id}.epub)`);
                continue;
            }

            try {
                const article = await getArticle(item.link);
                let options = {
                    title: article.title,
                    author: article.byline,
                    description: article.excerpt,
                    // date: new Date(item.pubDate),
                    content: [{ title: article.title, data: article.content }]
                }

                let epub = new EPub(options, epubFile);
                await epub.render();
            } catch (e) {
                console.error(`failed to parse article '${item.title}': ${e}`);
                continue;
            }

        }

        this.writeCache()
    }


    async sendAll(ignoreCache = false) {
        if (!this._mail) {
            throw new Error(`cannot send articles, no mail config`);
        }

        this.readCache();
        for (const file of fs.readdirSync(this._directory)) {
            if (path.extname(file) != ".epub") continue;

            const articleId = path.basename(file, ".epub");
            if (!ignoreCache && this.articleSent(articleId)) continue;
            this.sendArticle(articleId);
            break;
        }
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
            case "send": {
                await mailer.sendAll();
                break;
            }
            default: {
                console.error("unknwon command '" + command + "'")
            }
        }
    }
})()