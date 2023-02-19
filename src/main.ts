import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import process from 'process';
import { EPub } from '@lesjoursfr/html-to-epub';
import RSSParser from 'rss-parser';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

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
    if (!existsSync(outDir)) {
        mkdirSync(outDir);
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
        if (existsSync(epubFile)) {
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




(async () => {
    await rssToEpubSeparate(process.argv[2], path.resolve(process.argv[3]));
})()