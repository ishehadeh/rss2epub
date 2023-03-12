import { readFile } from "node:fs";
import nodemailer from "nodemailer";
import { ROOT_LOGGER } from "./root-logger.js";

const MOD_LOGGER = ROOT_LOGGER.child({ module: "transport-config" });

export type BaseTransportOptions = {
    from: string;
};

export type SMTPTransportOptions = BaseTransportOptions & {
    type: "smtp";
    from: string;
    host: string;
    port: number;
    tls: boolean;
    auth: {
        user: string;
        pass: string;
    };
};

export type TransportConfig = SMTPTransportOptions;

function isSMTPTransportOptions(o: any): o is SMTPTransportOptions {
    return (
        typeof o == "object" &&
        o["type"] == "smtp" &&
        typeof o["from"] == "string" &&
        typeof o["host"] == "string" &&
        typeof o["port"] == "number" &&
        typeof o["tls"] == "boolean" &&
        typeof o["auth"] == "object" &&
        typeof o["auth"]["user"] == "string" &&
        typeof o["auth"]["pass"] == "string"
    );
}

function isTransportConfig(o: any): o is TransportConfig {
    return isSMTPTransportOptions(o);
}

export async function readTransportConfig(configPath: string): Promise<TransportConfig> {
    const logger = MOD_LOGGER.child({ op: "readTransportConfig", configPath: configPath });

    logger.trace("reading config file");
    const configBuffer: Buffer = await new Promise((accept, reject) =>
        readFile(configPath, (err, buf) => (err ? reject(err) : accept(buf))),
    );

    logger.trace({ encoding: "utf-8", format: "json" }, "parsing config file");
    const configJson = JSON.parse(configBuffer.toString("utf-8"));

    if (!isTransportConfig(configJson)) {
        logger.error({ config: configJson }, "invalid transport config");
        throw new Error("invalid transport config");
    }

    return configJson;
}

export async function buildNodemailerFromTransportConfig(
    configPath: string,
): Promise<[BaseTransportOptions, nodemailer.Transporter]> {
    const logger = MOD_LOGGER.child({ op: "readTransportConfig", configPath: configPath });

    const transportConfig = await readTransportConfig(configPath);

    if (isSMTPTransportOptions(transportConfig)) {
        const {
            host,
            port,
            tls,
            auth: { user, pass },
        } = transportConfig;
        return [
            transportConfig,
            nodemailer.createTransport({
                host,
                port,
                requireTLS: tls,
                auth: {
                    user,
                    pass,
                },
            }),
        ];
    } else {
        logger.error(
            { transportConfig },
            "unreachable! Bad transport type. This should have been checked for already.",
        );
    }
}
