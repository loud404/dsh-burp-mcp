import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {DEFAULT_URL,DEFAULTS,makeRegistration} from '../config.js';
import {makeGatewayRegistration} from '../gateway-config.js';
const read=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
test('upstream and gateway defaults retain MCP and proxy separation',()=>{
 const upstream=makeRegistration();assert.equal(upstream.url,DEFAULT_URL);assert.equal(upstream.transport,'streamable-http');
 const gateway=makeGatewayRegistration();assert.equal(gateway.transport,'stdio');assert.equal(gateway.command,'node');assert.ok(gateway.args.includes(DEFAULT_URL));assert.ok(gateway.args.includes('http://127.0.0.1:8080'));assert.equal(gateway.toolCallTimeoutMs,130000);
});
test('configuration rejects invalid URLs and timeout budgets',()=>{
 for(const url of ['file:///tmp/mcp','http://u:p@localhost/mcp','bad'])assert.throws(()=>makeRegistration({url}));
 assert.throws(()=>makeGatewayRegistration({requestTimeoutMs:1000,toolCallTimeoutMs:500}));assert.throws(()=>makeGatewayRegistration({gatewayNode:'relative/node'}));
});
test('manifest includes all runtime resources and no lifecycle scripts',async()=>{
 const pkg=JSON.parse(await read('package.json'));assert.equal(pkg.name,'@local/dsh-burp-mcp');assert.equal(pkg.version,'1.3.1');assert.equal(pkg.engines.dsh,'0.2.2-rc.5');
 for(const key of ['install','postinstall','prepare'])assert.equal(pkg.scripts[key],undefined);
 for(const filename of ['index.js','gateway-config.js','mcp-gateway.js','mcp-gateway-main.mjs','http-transport.js','browser-plugin.js','browser-manager.js','browser-config.js','README.md','LICENSE','icon.svg']){assert.ok(pkg.files.includes(filename));await access(new URL('../'+filename,import.meta.url));}
 assert.equal(pkg.exports['./routing'],undefined);assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
});
test('portable bundle configuration contains no developer-specific executable paths',async()=>{
 const patch=await read('cordis.patch.example.yml');assert.match(patch,/gatewayNode: node/);assert.match(patch,/browserExecutable: ''/);assert.doesNotMatch(patch,/[A-Z]:\\(?:Users|RJ)\\/i);assert.doesNotMatch(patch,/burp-default-routing/);
});
test('localized metadata explains the same two MCP routes',async()=>{
 for(const language of ['zh','en']){const locale=JSON.parse(await read('locale/'+language+'.json'));assert.ok(locale.meta.description.includes('proxy'));assert.ok(locale.meta.description.includes('extension'));assert.ok(locale.meta.description.includes('mcp__burp__'));for(const field of Object.keys(DEFAULTS))assert.ok(locale.config[field]);}
});
test('plugin registers only the MCP gateway and withdraws it on disposal',async()=>{
 const {apply,Config}=await import('../index.js');assert.equal(Config({}).toolCallTimeoutMs,130000);const entries=new Map();let dispose;
 apply({effect(factory){dispose=factory();},mcpManager:{register(name,entry){entries.set(name,entry);return()=>entries.delete(name);}}},{});
 assert.equal(entries.get('burp').transport,'stdio');dispose();assert.equal(entries.size,0);
});
