# Bruno Web

Use the [Bruno](https://github.com/usebruno/bruno) API client in a browser. Collections live on the server and
requests are sent from the server, so you can use Bruno from a tablet, a thin laptop, or next to code that only
exists on a remote machine.

> **Unofficial.** Bruno Web is an independent project. It is not made, endorsed or supported by the Bruno team.
> "Bruno" is a trademark of Anoop M D; it is used here only to say which application this runs. Please report
> problems with Bruno Web here, not to the Bruno project.

## How it works

Bruno Web does not modify Bruno. It fetches Bruno at a pinned commit (`UPSTREAM_COMMIT`) and:

- runs the desktop app's main process (`packages/bruno-electron`) unchanged on Node 22, with a stand-in `electron`
  module (`server/electron-shim/`);
- serves Bruno's own renderer build to the browser, with a `window.ipcRenderer` that talks to the server over a
  WebSocket (`web/bridge.js`);
- replaces the things a browser cannot do the desktop way: native file dialogs become a server-side file browser,
  exports can be downloaded, OAuth2 sign-in runs in a pop-up, Bruno Apps run in sandboxed iframes.

The design notes, trade-offs and review history are in [docs/DESIGN.md](docs/DESIGN.md) (Chinese).

## Quick start (local)

Requires Node 22.13+ and git.

```bash
npm install
scripts/fetch-upstream.sh          # fetch and build Bruno at UPSTREAM_COMMIT (about 3 minutes)
BRUNO_WEB_AUTH=none npm start      # listens on 127.0.0.1:8484 only, no login
```

Open http://127.0.0.1:8484.

## Docker

```bash
docker build -t bruno-web .
docker run -d -p 8484:8484 -v bruno-data:/data \
  -e BRUNO_WEB_PASSWORD='choose-a-password' \
  -e BRUNO_WEB_SECRET_KEY='a-long-random-string' \
  bruno-web
```

The container runs as uid 1000 and keeps everything in `/data`: `userData/` (preferences, cookies, OAuth2 tokens),
`workspace/` (collections), `uploads/` (files picked in the browser), `sessions.json` (logins).

After deploying, open `/bruno-web/selfcheck` (logged in). Only a 200 means the deployment works: it runs the script
sandbox, writes and reads SQLite, sends a real request through Bruno's HTTP client, and checks that every channel the
page uses has a handler on the server.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8484` / `127.0.0.1` | Listen address (`HOST=0.0.0.0` in the image) |
| `BRUNO_WEB_DATA` | `./data` | Data directory |
| `BRUNO_WEB_ROOTS` | `$BRUNO_WEB_DATA/workspace` | Directories the file dialogs may browse, separated by `:` |
| `BRUNO_WEB_AUTH` | `password` | `password`, `proxy` (a reverse proxy authenticates), or `none` (loopback only) |
| `BRUNO_WEB_PASSWORD` / `BRUNO_WEB_PASSWORD_HASH` | | The login password, or its hash as `scrypt$<salt hex>$<hash hex>` |
| `BRUNO_WEB_PROXY_USER_HEADER` / `BRUNO_WEB_PROXY_SECRET_HEADER` / `BRUNO_WEB_PROXY_SECRET` | | `proxy` mode: user header, shared-secret header and the secret |
| `BRUNO_WEB_PUBLIC_URL` | | Public address (e.g. `https://bruno.example.com`); only pages from it are accepted, and OAuth2 callback URLs are built from it |
| `BRUNO_WEB_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers |
| `BRUNO_WEB_SECRET_KEY` | generated into `userData/` | Master key for secrets Bruno stores encrypted |
| `BRUNO_WEB_ALLOW_DEVELOPER_MODE` | `false` | Allow scripts' Developer Mode and npm installs, i.e. arbitrary code on the server |
| `BRUNO_WEB_ENABLE_TERMINAL` | `false` | The built-in terminal, i.e. a server shell in the browser |
| `BRUNO_WEB_BLOCK_METADATA` | `true` | Refuse connections to cloud metadata addresses such as 169.254.0.0/16 (best effort) |
| `BRUNO_WEB_SAMPLE_COLLECTION` | `true` | Import a sample collection on first start |
| `BRUNO_WEB_SESSION_TTL_HOURS` | `12` | Login lifetime, extended while in use. Logins survive restarts; changing the password logs everyone out |
| `BRUNO_WEB_MAX_RESULT_MB` / `BRUNO_WEB_MAX_MESSAGE_MB` | `512` / `64` | Largest single message server → page and page → server |
| `BRUNO_WEB_DEBUG_IPC` | `false` | Log every message in the browser console |

All `BRUNO_WEB_*` variables are removed from the process environment once read, so collection scripts
(`bru.getProcessEnv()`) cannot see them.

## Security model

Read this before exposing an instance to anyone else.

- **One instance per person, or per small group that trusts each other.** There is one shared password and no
  per-user accounts or permissions. For many users, run one container per user behind a single sign-on proxy
  (`BRUNO_WEB_AUTH=proxy`).
- **Do not put it on the internet without a login in front.** `BRUNO_WEB_AUTH=none` only starts on a loopback
  address for this reason.
- **Requests come from the server.** `localhost` means the server, and the server's network is reachable. Restrict the
  container's outbound traffic (firewall, Kubernetes NetworkPolicy).
- **The container is the boundary.** `BRUNO_WEB_ROOTS` limits what the file dialogs show, not what the process can
  read or write.
- **Code execution features are off by default**: Developer Mode scripts, npm installs and the terminal.
- Do not pass platform credentials to the container as environment variables; scripts can read everything except
  `BRUNO_WEB_*`.

## Differences from the desktop app

| Area | Bruno Web |
| --- | --- |
| Picking files or folders | A file browser for the server, plus upload from your computer |
| Export | Download to your computer, or save on the server |
| OAuth2 sign-in | Runs in a pop-up. With the callback URL set to `<public URL>/bruno-web/oauth2/callback` it completes on its own (implicit grant included); otherwise paste the redirect URL back into Bruno. Custom headers for the authorization page and Bruno's "ignore certificate errors" setting do not apply there |
| Bruno Apps | Run in sandboxed iframes with an opaque origin: isolated from each other and from Bruno's login state, no localStorage, `location.origin` is `null`; clipboard write is allowed, clipboard read, location, camera and the like are refused |
| WSDL that references other files | The browser hands over only the chosen file, so multi-file WSDL cannot be imported from your computer (single-file WSDL works) |
| Large responses | Supported; the response travels to the browser, so 50 MB takes about 90 MB on the wire (limit `BRUNO_WEB_MAX_RESULT_MB`) |
| Closing the tab | The browser asks first when a request has unsaved changes (the desktop app asks when quitting) |
| Phones and tablets | On touch screens up to 1024 px wide the sidebar becomes a drawer, row menus stay visible, dialogs fit the screen and tables scroll sideways; up to 900 px request and response, environments, preferences and the runner stack vertically. Touch selection and input methods inside the code editors are upstream behaviour and not specially adapted |
| Several browser tabs | One tab is active at a time; a new tab takes over |
| Developer Mode scripts, terminal, npm installs | Off by default |

## Tests

```bash
npm test                                             # unit tests
npx playwright test -c test/e2e/playwright.config.js # Bruno Web behaviour: file dialogs, reconnects, takeover, OAuth2, policies, phones
scripts/check-upstream-selectors.js                  # every upstream class our CSS/JS relies on still exists
scripts/upstream-e2e.sh                              # Bruno's own end-to-end suite, run against Bruno Web
```

`scripts/upstream-e2e.sh` uses upstream's tests and fixtures unchanged and only replaces "launch the Electron app"
with "start a Bruno Web server and open a browser tab". It is memory hungry (about 1.5 GB per worker); set
`E2E_WORKERS`. Known differences are listed in `test/upstream-e2e/known-failures.txt`, and
`scripts/compare-upstream-results.js` fails only on failures not listed there.

## Upgrading Bruno

`scripts/upstream-gate.sh <commit-or-tag>` fetches and builds that Bruno in a separate directory and runs every check
above; it exits non-zero on any new failure. By hand: change `UPSTREAM_COMMIT`, run `scripts/fetch-upstream.sh`,
check `/bruno-web/selfcheck` (channel coverage and "unimplemented Electron APIs"), then run the tests.

## License

Bruno Web is released under the [MIT License](LICENSE).

Bruno is © Anoop M D, Anusree P S and contributors, also under the MIT License. Builds and container images of Bruno
Web contain Bruno; its license is kept at `upstream/license.md`. Bruno's logo is not used by this project.
