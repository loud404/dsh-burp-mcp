export const DEFAULT_URL = 'http://127.0.0.1:9876/mcp';
export const DEFAULTS = Object.freeze({
  url: DEFAULT_URL,
  startupTimeoutMs: 15000,
  toolCallTimeoutMs: 120000,
  closeTimeoutMs: 5000,
});

export function makeRegistration(config = {}) {
  const input = config.url ?? DEFAULT_URL;
  if (typeof input !== 'string') throw new TypeError('Burp MCP URL must be a string');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Burp MCP URL must use HTTP or HTTPS');
  if (url.username || url.password || url.hash) throw new Error('Burp MCP URL must not contain credentials or a fragment');
  const result = { transport: 'streamable-http', url: url.href };
  for (const field of ['startupTimeoutMs', 'toolCallTimeoutMs', 'closeTimeoutMs']) {
    const value = config[field] ?? DEFAULTS[field];
    if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error(`${field} must be an integer between 1 and 2147483647`);
    result[field] = value;
  }
  return {
    ...result,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 },
  };
}
