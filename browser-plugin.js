import z from '@deepseek-ai/schemastery';
import { BROWSER_DEFAULTS } from './browser-config.js';
import { BurpBrowserManager } from './browser-manager.js';

export const name = 'burp-proxy-browser';
export const inject = ['tools'];
export const Config = z.object({
  proxyUrl: z.string().default(BROWSER_DEFAULTS.proxyUrl),
  browserExecutable: z.string().default(''),
  browserTimeoutMs: z.number().min(1000).max(120000).default(BROWSER_DEFAULTS.browserTimeoutMs),
  trustBurpCA: z.boolean().default(true),
});

export function apply(ctx, config = {}) {
  const manager = new BurpBrowserManager(config);
  ctx.effect(() => () => manager.dispose());
  ctx.on('agent/disposed', ({ agent }) => {
    void manager.serial(() => manager.closeOwner(agent)).catch(error => console.error('Burp browser cleanup:', error.message));
  });
  ctx.effect(() => ctx.tools.register({
    name: 'burp_browser',
    description: 'Open and manage a visible dedicated Chrome/Chromium window. HTTP/HTTPS and WS/WSS use Burp Proxy by default, with no direct fallback. Use open to create/reuse a window, navigate for another URL, status for current tabs, and close to end the temporary session. Only this window is affected; existing browsers, web_fetch, and shell tools are unchanged. Closing the window discards temporary cookies. Proxy HTTPS uses a certificate-error exception limited to the CA public key fetched from the local Burp listener; direct mode uses normal certificate validation. Downloads and service workers are blocked in this test session.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['open', 'navigate', 'status', 'close'], description: 'open creates/reuses one dedicated browser per DSH session; close discards it.' },
        url: { type: 'string', description: 'HTTP(S) URL for open or navigate. open defaults to about:blank; navigate requires a URL.' },
        route: { type: 'string', enum: ['proxy', 'direct'], description: 'open/navigate always default to proxy when omitted, even after direct. Set direct only when the user explicitly requests a direct connection. Changing route discards the old temporary profile. route only affects open/navigate; status/close always observe/close the current session and do not switch it.' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 150000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return JSON.stringify(await manager.run(exec.agent, args, exec.signal), null, 2);
    },
  }));
}
