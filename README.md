# boltclient-ci

Replay your API collection in CI before you deploy, not after a customer hits the break.

`boltclient-ci` runs a Boltclient collection — or a Thunder Client / Postman v2.1 export,
auto-detected, no separate conversion step — against a named environment and exits non-zero
if any request comes back `4xx`/`5xx` or can't connect. It is the same request/substitution
logic the Boltclient VS Code extension uses in the editor, so the collection you build by hand
while debugging is the exact one CI replays.

```
$ BOLTCLIENT_KEY=... npx github:growaleaf/boltclient-ci run --env production
Boltclient CI — "api-smoke-test", 3 request(s):
  ok    GET    health check — 200 in 41ms
  ok    POST   create widget — 201 in 118ms
  FAIL  GET    get widget by id — 404 in 37ms
```

## Install

No npm account needed — install straight from the GitHub repo:

```
npm install github:growaleaf/boltclient-ci
```

Or run it without installing:

```
npx github:growaleaf/boltclient-ci run
```

## Usage

```
node cli.js run [--file <collection.json>] [--dir <.boltclient dir>] [--env <name>] [--json]
```

- `--dir` points at a `.boltclient` folder (the same one Boltclient writes in your repo) and
  runs the first collection file it finds there. Default: `./.boltclient`.
- `--file` runs one collection file directly — a native Boltclient export, a Thunder Client
  export, or a Postman v2.1 export, auto-detected from its shape.
- `--env` selects an environment from that folder's `environments.json` and resolves its
  `{{variables}}` into every request's URL/params/headers/body before sending.

| Exit code | Meaning |
|---|---|
| 0 | every request returned 2xx/3xx |
| 1 | one or more requests returned 4xx/5xx, or failed to connect — fail the build on this |
| 2 | configuration error — no collection found, bad JSON, `--dir` missing |
| 3 | no valid Pro license found |

`--json` writes the full per-request report (status, time, error) to stdout, suited to a
PR-comment bot or a smoke-test artifact.

### Secrets

A variable flagged `{"secret": true}` in `environments.json` (the same flag Boltclient writes
when you store a secret in the editor) has no VS Code SecretStorage to read from here, so the
CLI reads it from `process.env` instead — set a CI secret named either exactly like the
variable or its upper-cased form (`apiKey` → `APIKEY`).

## License

Requires a Pro license key, checked **offline** — the key is an ECDSA-signed token verified
locally; the CLI makes no network call to check it, ever. Set it once:

```
export BOLTCLIENT_KEY=<your key>       # CI secret
# or, on your own machine:
mkdir -p ~/.boltclient && echo "<your key>" > ~/.boltclient/license
```

Buy a key: https://boltclient-ci.madeforthisday.com (one-time purchase, no subscription). The
same key also unlocks the Boltclient VS Code extension's Pro tier once that listing is live —
one purchase, both surfaces.

## How this differs from an existing tool you may already know

[Newman](https://www.npmjs.com/package/newman) is Postman's own mature, widely-used CLI
collection runner, and [`@thunderclient/cli`](https://www.npmjs.com/package/@thunderclient/cli)
is Thunder Client's. Both are real, free, and a reasonable default if your team already lives
in that tool's format. `boltclient-ci` is a narrower slice: a single dependency-free Node file
with zero npm packages pulled in, built for a developer who already has a Boltclient collection
(built in-editor, committed as plain JSON in `.boltclient/`) and wants to replay it in CI without
re-encoding it into another tool's export format — it also auto-imports a Thunder Client or
Postman export directly, with no separate conversion CLI needed first.

## Privacy / cost

Requests execute directly from Node — nothing is sent anywhere except the HTTP requests your
own collection defines. The license check makes no network call. $0 to run.

## Source

Source is readable here before you buy. Running `cli.js` for anything beyond evaluation needs
the Pro key (see `LICENSE`).
