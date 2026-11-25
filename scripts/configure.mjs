#!/usr/bin/env node
import { readFile, writeFile, copyFile, access, realpath, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findBrowser } from '../browser-manager.js';
import { normalizeBrowserConfig } from '../browser-config.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const values=process.argv.slice(2);
if(values.includes('--help')){
  console.log('Usage: node scripts/configure.mjs [--node ABSOLUTE_PATH] [--browser ABSOLUTE_PATH] [--mcp URL] [--proxy URL]');
  console.log('Writes local Node/browser paths to cordis.patch.yml and saves cordis.patch.yml.bak. No network requests or profile changes.');
  process.exit(0);
}
const options={};
for(let i=0;i<values.length;i+=2){
  const key=values[i];if(!['--node','--browser','--mcp','--proxy'].includes(key)||!values[i+1]||values[i+1].startsWith('--'))throw new Error('Unknown option or missing value: '+key);
  if(key in options)throw new Error('Duplicate option: '+key);options[key]=values[i+1];
}
const node=await realpath(options['--node']||process.execPath);
if(!path.isAbsolute(node))throw new Error('Node path must be absolute');
await access(node);
if(!(await stat(node)).isFile())throw new Error('Node path must name an executable file');
const nodeCheck=spawnSync(node,['-e','process.exit(process.versions.electron || Number(process.versions.node.split(".")[0]) < 22 ? 9 : 0)'],{stdio:'ignore',timeout:5000,windowsHide:true});
if(nodeCheck.error||nodeCheck.status!==0)throw new Error('Selected executable must be standalone Node.js 22 or newer');
if(process.versions.electron&&!options['--node'])throw new Error('Run this script with standalone Node, not Desktop Electron');
const mcp=new URL(options['--mcp']||'http://127.0.0.1:9876/mcp');
if(!['http:','https:'].includes(mcp.protocol)||mcp.username||mcp.password||mcp.hash)throw new Error('Invalid MCP URL');
const proxy=normalizeBrowserConfig({proxyUrl:options['--proxy']||'http://127.0.0.1:8080'}).proxyUrl;
let browser='';
try{browser=await findBrowser(options['--browser']||'');}catch(error){if(options['--browser'])throw error;console.warn('Chrome was not found automatically. MCP tools still work; configure browserExecutable later if needed.');}
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const config=`- insert:
    - id: burp-mcp
      name: '@local/dsh-burp-mcp'
      config:
        url: ${quote(mcp.href)}
        proxyUrl: ${quote(proxy)}
        gatewayNode: ${quote(node)}
        startupTimeoutMs: 45000
        toolCallTimeoutMs: 130000
        requestTimeoutMs: 120000
        closeTimeoutMs: 10000
        maxResponseBytes: 2097152
    - id: burp-proxy-browser
      name: '@local/dsh-burp-mcp/browser'
      config:
        proxyUrl: ${quote(proxy)}
        browserExecutable: ${quote(browser)}
        browserTimeoutMs: 20000
        trustBurpCA: true
`;
const target=path.join(root,'cordis.patch.yml');
await readFile(target,'utf8');
await copyFile(target,target+'.bak');
await writeFile(target,config,'utf8');
if(await readFile(target,'utf8')!==config)throw new Error('Configuration readback mismatch');
console.log('Configuration saved: '+target);
console.log('Node: '+node);console.log('Browser: '+(browser||'auto-detect on use'));console.log('MCP: '+mcp.href);console.log('Proxy: '+proxy);
console.log('Next: add this local directory in DSH Plugins, then enable it. If already installed, restart DSH.');
