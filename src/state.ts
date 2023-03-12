/** An entry in a log of sent emails, useful for avoiding sending the same article multiple times
 *
 */
export type EmailLogEntry = {
    date: string;

    // recipient email address
    to: string;

    // recipient email address
    from: string;

    // transport name in `transport.json`
    transport: string;

    // list of URLs sent in this email
    sentURLs: string[];

    status: SendStatus;
};

export type SendStatus = "FAILED" | "SUCCESS";

export class StateManager {
    _emailsSent: EmailLogEntry[];

    constructor(sentList: EmailLogEntry[] = []) {
        this._emailsSent = sentList;
    }

    getSentEmails(): ReadonlyArray<EmailLogEntry> {
        return this._emailsSent;
    }
    // get a list of article URLs sent to the given recipient(s)
    getSentArtcles(to: string[] = []): string[] {
        return this._emailsSent
            .filter(e => e.status == "SUCCESS")
            .filter(e => to.includes(e.to))
            .flatMap(e => e.sentURLs);
    }
}
