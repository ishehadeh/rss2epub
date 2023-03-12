# rss2epub

A simple CLI for bundling individual articles or feeds as EPUB files.
Includes support for emailing generated e-books, in they're accessible on e-readers.

## Usage

```sh
rss2epub [OPTIONS] <FEED|URL>
```

### Options

- `--transport-config <path>` path to [Transport Config](#transport-config), (DEFAULT: `~/.config/rss2epub/transport.json`)
- `--transport <TRANSPORT>` send the generated file using the given mail transport, see [Transport Config](#transport-config) (NOTE: requires `--to`)
- `--to <email>` send the generated file to the given email (NOTE: requires `--transport`)
- `--out <path>` write the generate file to `path`. When the [Mode](#modes) is `individual`, `--out` must be a directory. [default: "/tmp/rss2epub"]
- `--order date` order the articles by date before compiling/sending (depends on `--mode`)
- `--reverse` reverses the articles order before compiling/sending (depends on `--mode`)
- `--mode <MODE>` see [Modes](#modes)

### Modes

Currently, two EPUB generation modes are supported:

- `individual` each article is put in its own EPUB file.
- `bundle` articles are bundled into a single EPUB, where each chapter is a article.

## Transport Config

The transport config defines ways how emails should be sent. This file is optional, by default it lives in `~/.config/rss2epub/transport.json`. This can be changed with the `--transport-config` [Option](#options).
Currently, the only supported transport is `smtp`.

### Schema

```json5
{
    // The transport name is "example".
    // The name is used to reference it on the CLI with `--transport` flag
    "example": {
        "type": "smtp", // only "smtp" transports are supported, currently.
        "from": "sender@example.com", // the "From" field in emails sent from this transport
        "host": "mail.example.com", // SMTP host
        "port": 25, // SMTP port

        // enable/disable secure connection.
        // THIS SHOULD ALWAYS BE TRUE!
        // otherwise your credentials will be sent in plaintext!
        "tls": true,

        // auth credentials
        "auth": {
            "user": "sender@example.com",
            "pass": "PASSWORD!"
        }
    }
}
```
