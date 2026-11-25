# Development

## Structure

- `index.js` / `gateway-config.js`: DSH bundle entry and stdio MCP registration.
- `mcp-gateway-main.mjs`: SDK-owned stdio lifecycle and connection to the real Burp MCP server.
- `mcp-gateway.js`: tool discovery snapshot, `proxy|extension` selection and forwarding.
- `http-transport.js`: the Proxy-mode HTTP sender, not a separate agent tool.
- `browser-*.js`: optional isolated Chrome session.
- `scripts/configure.mjs`: writes local executable paths without touching the DSH profile.
- `tests/`: local protocol/behavior regression tests. No external test targets.

## Run checks

```sh
npm install --ignore-scripts
npm test
npm run check
```

The package intentionally has no install, postinstall, or prepare script. Playwright Core does not bundle or download a browser here.

`package-lock.json` supports reproducible `npm ci --ignore-scripts` installs. `pnpm-lock.yaml` records the same reviewed dependency set for pnpm users. CI uses npm ci; no lifecycle scripts are run.

## Configuration and contributions

The committed `cordis.patch.yml` is portable. `node scripts/configure.mjs` intentionally modifies it locally and writes `.bak`; do not commit personal executable paths. Keep target traffic, cookies, tokens, CA private keys, browser profiles and DSH session logs out of issues and commits.

Before a pull request, run tests, inspect the diff, and explain whether MCP route semantics, cancellation, request framing, or lifecycle behavior changed.

## Behavioral contract

- Omitting an MCP send route always selects Proxy.
- `extension` forwards to the original Burp tool; it is never named `direct`.
- No automatic route fallback or target-request replay.
- Non-send tool schemas/results remain upstream-owned.
- Startup/probe performs metadata work only; target requests require `tools/call`.
- Stdout is MCP JSON-RPC only; diagnostics use stderr.
- Session cookies are temporary in the optional browser.

## Compatibility

DSH integration was verified against 0.2.2-rc.5 on Windows. The package uses APIs and protocol behavior from that installation. Other DSH versions require review, not a compatibility exemption based solely on a successful import.
