# Reporting security issues

Use this plugin only for systems you own or have permission to test. The plugin is a routing/integration tool, not a network isolation boundary.

Do not attach tokens, cookies, authorization headers, browser profiles, CA private keys, sensitive responses or private target URLs to a public issue.

For an ordinary bug, open an issue with the DSH/Node/Burp versions, selected route, a redacted error and minimal reproduction. For a vulnerability that could expose data or execute unintended commands, use GitHub's private vulnerability reporting when available; otherwise contact the repository owner before publishing sensitive details.

## Relevant behavior

- Proxy mode reaches the configured local Burp listener and follows Proxy Intercept settings; it does not invoke the MCP extension's HTTP approval dialog.
- Extension mode invokes the original Burp MCP HTTP API and retains that extension's approval flow.
- No route fallback is performed automatically.
- The optional browser uses a fresh temporary profile. Direct browser mode is separate from MCP extension mode.
- The local configuration helper writes executable paths to `cordis.patch.yml`; review local changes before committing them.
