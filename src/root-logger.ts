import pino from "pino";

export const ROOT_LOGGER = pino({
    transport: {
        target: "pino-pretty",
    },
});
