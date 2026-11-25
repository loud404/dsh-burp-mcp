export const BROWSER_DEFAULTS = Object.freeze({
  proxyUrl: 'http://127.0.0.1:8080',
  browserExecutable: '',
  browserTimeoutMs: 20000,
  trustBurpCA: true,
});

export function normalizeBrowserConfig(config = {}) {
  const proxy = new URL(config.proxyUrl ?? BROWSER_DEFAULTS.proxyUrl);
  if (proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname)) throw new Error('Burp Proxy must be an HTTP listener on loopback');
  if (proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') throw new Error('Proxy URL must contain only a loopback host and port');
  if (Number(proxy.port || 80) === 9876) throw new Error('9876 is the MCP control port; use the Burp Proxy listener port, usually 8080');
  const timeout = config.browserTimeoutMs ?? BROWSER_DEFAULTS.browserTimeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('browserTimeoutMs must be an integer from 1000 to 120000');
  const trustBurpCA = config.trustBurpCA ?? BROWSER_DEFAULTS.trustBurpCA;
  if (typeof trustBurpCA !== 'boolean') throw new Error('trustBurpCA must be boolean');
  return { proxyUrl: proxy.origin, browserExecutable: config.browserExecutable || '', browserTimeoutMs: timeout, trustBurpCA };
}

export function validatePageUrl(input = 'about:blank') {
  if (input === 'about:blank') return input;
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser navigation accepts HTTP or HTTPS only');
  if (url.username || url.password) throw new Error('Put sign-in details in the browser, not in its URL');
  return url.href;
}

export function validateBrowserRoute(route = 'proxy') {
  if (!['proxy', 'direct'].includes(route)) throw new Error('route must be proxy or direct');
  return route;
}

export function browserLaunchOptions(config, executablePath, spki, headless = false, route = 'proxy') {
  validateBrowserRoute(route);
  const args = [
    route === 'proxy' ? '--proxy-bypass-list=<-loopback>' : '--no-proxy-server',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=DnsOverHttps,EncryptedClientHello',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (route === 'proxy' && spki) args.push(`--ignore-certificate-errors-spki-list=${spki}`);
  return {
    executablePath, headless, chromiumSandbox: true,
    ...(route === 'proxy' ? { proxy: { server: config.proxyUrl, bypass: '<-loopback>' } } : {}),
    args,
    ignoreHTTPSErrors: false,
    acceptDownloads: false,
    serviceWorkers: 'block',
    timeout: config.browserTimeoutMs,
    viewport: null,
  };
}
