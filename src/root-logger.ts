import { env } from "node:process";
import pino from "pino";

export const ROOT_LOGGER = pino({
    transport: {
        target: "pino-pretty",
    },
    level: env["RSS2EPUB_LOG"] || "info",
});
