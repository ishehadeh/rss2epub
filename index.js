import axios from 'axios';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import process from 'process';
import { EPub } from '@lesjoursfr/html-to-epub';
import RSSParser from 'rss-parser';
import path from 'path';


// try to make all img src that fail to parse as a URL relative to `base`
function makeImageSrcsAbsolute(document, base) {
    const images = document.querySelectorAll("img");
    for (const image of images) {
        try {
            const _url = new URL(image.src);
        } catch (e) {
            if (e instanceof TypeError && e.code == "ERR_INVALID_URL") {
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
    const resp = await axios({
        method: 'get',
        url: url,
        responseType: 'string'
    });
    const dom = new JSDOM(resp);
    makeImageSrcsAbsolute(dom.window.document, url);
    const reader = new Readability(dom.window.document);
    return reader.parse()
}

async function epubFromArticles(title, articles, path) {
    let options = {
        title,
        verbose: true,
        author: "article2epub",
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


await rssToEpub(process.argv[2], path.resolve(process.argv[3]));