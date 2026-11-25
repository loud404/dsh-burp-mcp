import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_URL, makeRegistration } from './config.js';
import { normalizeBrowserConfig } from './browser-config.js';

export function makeGatewayRegistration(config={}) {
  const base=makeRegistration({...config,toolCallTimeoutMs:config.toolCallTimeoutMs??130000});
  const proxyUrl=normalizeBrowserConfig(config).proxyUrl;
  const command=config.gatewayNode||'node';
  if(typeof command!=='string'||!command||(!path.isAbsolute(command)&&command!=='node'))throw new Error('gatewayNode must be an absolute Node path or node');
  const requestTimeoutMs=config.requestTimeoutMs??120000;
  const maxResponseBytes=config.maxResponseBytes??2097152;
  if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1000||requestTimeoutMs>300000)throw new Error('requestTimeoutMs must be 1000..300000');
  if(!Number.isInteger(maxResponseBytes)||maxResponseBytes<1024||maxResponseBytes>16777216)throw new Error('maxResponseBytes must be 1024..16777216');
  if(base.toolCallTimeoutMs<requestTimeoutMs)throw new Error('toolCallTimeoutMs must cover requestTimeoutMs');
  return {
    transport:'stdio',command,
    args:[fileURLToPath(new URL('./mcp-gateway-main.mjs',import.meta.url)),'--upstream',base.url||DEFAULT_URL,'--proxy',proxyUrl,'--timeout',String(requestTimeoutMs),'--startup','15000','--maxResponseBytes',String(maxResponseBytes)],
    cwd:fileURLToPath(new URL('./',import.meta.url)),
    startupTimeoutMs:config.startupTimeoutMs??45000,
    toolCallTimeoutMs:base.toolCallTimeoutMs,
    closeTimeoutMs:config.closeTimeoutMs??10000,
    reconnect:base.reconnect,
  };
}
