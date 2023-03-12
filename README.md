# rss2epub

A simple CLI for bundling individual articles or feeds as EPUB files.
Includes support for emailing generated e-books, in they're accessible on e-readers.

## Usage

```sh
rss2epub [OPTIONS] ...URLS
```

`URLS` is a series of links to articles or feed to bundle into an epub.

### Options

- `--transport-config <path>` path to [Transport Config](#transport-config), (DEFAULT: `~/.config/rss2epub/transport.json`)
- `--transport <TRANSPORT>` send the generated file using the given mail transport, see [Transport Config](#transport-config) (NOTE: requires `--to`)
- `--to <email>` send the generated file to the given email (NOTE: requires `--transport`)
- `--out <path>` write the generate file to `path`.
- `--order date` order the articles by date before compiling
- `--after <DATE>` only consider articles in feeds newer than the given date (NOTE: doesn't affect single articles)
- `--before <DATE>` only consider articles in feeds older than the given date (NOTE: doesn't affect single articles)
- `--reverse` reverses the articles order before compiling

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

        // force TLS
        "tls": true,

        // auth credentials
        "auth": {
            "user": "sender@example.com",
            "pass": "PASSWORD!"
        }
    }
}
```
