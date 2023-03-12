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

export type TransportOptions = SMTPTransportOptions;

export type TransportConfig = {
    [name: string]: TransportOptions;
};

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

function isTransportOptions(o: any): o is TransportOptions {
    return isSMTPTransportOptions(o);
}

function isTransportConfig(o: any): o is TransportConfig {
    return typeof o === "object" && Object.entries(o).every(([k, v]) => typeof k == "string" && isTransportOptions(v));
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
    transportName: string,
): Promise<[BaseTransportOptions, nodemailer.Transporter]> {
    const logger = MOD_LOGGER.child({ op: "readTransportConfig", configPath: configPath, transportName });

    const config = await readTransportConfig(configPath);

    if (!(transportName in config)) {
        logger.error({ availableTransports: Object.keys(config) }, "transport not in config");
        throw new Error("transport not in config");
    }

    const transportConfig = config[transportName];
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
        logger.error({ config }, "unreachable! Bad transport type. This should have been checked for already.");
    }
}
