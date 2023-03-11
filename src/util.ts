import https from "https";
import { ROOT_LOGGER } from "./root-logger.js";

const LOGGER = ROOT_LOGGER.child({ module: "util" });

export async function downloadFile(url: URL | string): Promise<Buffer> {
    const downloadLogger = LOGGER.child({ url: url.toString() });

    downloadLogger.debug("downloading file");
    downloadLogger.trace({ method: "GET" }, "request");
    return await new Promise((resolve, reject) => {
        https
            .get(url, response => {
                const code = response.statusCode ?? 0;
                downloadLogger.trace({ code }, "response");

                if (code >= 400) {
                    downloadLogger.debug(
                        { code, errorMessage: response.statusMessage },
                        "response code in error range",
                    );
                    return reject(new Error(response.statusMessage));
                }

                // handle redirects
                if (code > 300 && code < 400 && response.headers.location != undefined) {
                    downloadLogger.trace({ location: response.headers.location }, "following redirect");
                    return resolve(downloadFile(response.headers.location));
                }

                const chunks = [];
                response.on("data", chunk => {
                    downloadLogger.trace({ chunkSize: chunk.length }, "recieved chunk");
                    chunks.push(chunk);
                });
                response.on("end", () => {
                    downloadLogger.debug("download complete");
                    resolve(Buffer.concat(chunks));
                });
                response.on("error", e => {
                    downloadLogger.warn({ errorMessage: e.message }, "error during download");
                    reject(e);
                });
            })
            .on("error", error => {
                reject(error);
            });
    });
}
