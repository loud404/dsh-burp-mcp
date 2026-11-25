# Changelog

## 1.3.1 — Public distribution

- Publish a portable configuration without machine-specific Node/Chrome paths.
- Add a local configuration helper, Chinese user guide and troubleshooting steps.
- Prefer installed Google Chrome/Chromium for the optional dedicated browser.
- Preserve the two MCP HTTP routes introduced in 1.3.0: proxy by default, extension explicitly.

## 1.3.0 — MCP-controlled routing

- Keep both HTTP sending modes on the same MCP tools.
- Add `route: proxy|extension`; omission selects Burp Proxy.
- Forward extension-mode requests to the original Burp extension HTTP API.
- Preserve non-sending Burp tools and startup capability discovery.
