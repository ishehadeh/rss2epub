export type SMTPTransportOptions = {
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
