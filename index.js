import z from '@deepseek-ai/schemastery';
import { DEFAULTS } from './config.js';
import { makeGatewayRegistration } from './gateway-config.js';

export const name = 'burp-mcp';
export const inject = ['mcpManager'];

const timeout = value => z.number().min(1).max(2147483647).default(value);
export const Config = z.object({
  url: z.string().default(DEFAULTS.url),
  startupTimeoutMs: timeout(45000),
  toolCallTimeoutMs: timeout(130000),
  closeTimeoutMs: timeout(10000),
  proxyUrl: z.string().default('http://127.0.0.1:8080'),
  gatewayNode: z.string().default('node'),
  requestTimeoutMs: timeout(120000),
  maxResponseBytes: z.number().min(1024).max(16777216).default(2097152),
});

export function apply(ctx, config = {}) {
  const registration = makeGatewayRegistration(config);
  ctx.effect(() => ctx.mcpManager.register('burp', registration));
}
