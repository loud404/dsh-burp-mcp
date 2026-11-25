import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { normalizeBrowserConfig, browserLaunchOptions, validatePageUrl, validateBrowserRoute } from '../browser-config.js';
import { BurpBrowserManager } from '../browser-manager.js';

function fakeBrowser() {
  const context = new EventEmitter();
  let url = 'about:blank';
  const page = { url: () => url, async goto(next) {url=next;}, async bringToFront() {} };
  context.pages = () => [page];
  context.newPage = async () => page;
  context.close = async () => {context.closed=true;context.emit('close');};
  return context;
}
const certificate = async () => ({spki:'fixture-ca-spki',fingerprint:'fixture-ca-fingerprint'});

test('browser defaults separate the proxy and MCP ports', () => {
  const config=normalizeBrowserConfig();
  assert.equal(config.proxyUrl,'http://127.0.0.1:8080');
  assert.equal(config.trustBurpCA,true);
  for (const proxyUrl of ['http://127.0.0.1:9876','http://external.test:8080','https://127.0.0.1:8080','http://u:p@localhost:8080','http://localhost:8080/path']) assert.throws(()=>normalizeBrowserConfig({proxyUrl}));
});
test('proxy launch has no DIRECT fallback, no blanket TLS ignore, and preserves sandbox', () => {
  const options=browserLaunchOptions(normalizeBrowserConfig(),'browser.exe','CA_PIN');
  assert.equal(options.chromiumSandbox,true);
  assert.equal(options.ignoreHTTPSErrors,false);
  assert.equal(options.headless,false);
  assert.deepEqual(options.proxy,{server:'http://127.0.0.1:8080',bypass:'<-loopback>'});
  assert.ok(options.args.includes('--disable-quic'));
  assert.ok(options.args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(options.args.includes('--ignore-certificate-errors-spki-list=CA_PIN'));
  assert.ok(options.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.equal(options.args.includes('--ignore-certificate-errors'),false);
  assert.equal(options.args.includes('--no-sandbox'),false);
  assert.ok(options.args.every(arg=>!arg.includes('DIRECT')));
  const strict=browserLaunchOptions(normalizeBrowserConfig(), 'browser.exe');
  assert.equal(strict.args.some(arg=>arg.includes('ignore-certificate')),false);
});
test('direct launch disables proxy and never adds a CA exception', () => {
  const options=browserLaunchOptions(normalizeBrowserConfig(),'browser.exe','CA_PIN',false,'direct');
  assert.ok(options.args.includes('--no-proxy-server'));
  assert.equal(Object.hasOwn(options,'proxy'),false);
  assert.equal(options.args.some(arg=>/--proxy-|ignore-certificate/.test(arg)),false);
  assert.equal(options.ignoreHTTPSErrors,false);
  assert.equal(options.chromiumSandbox,true);
  assert.throws(()=>browserLaunchOptions(normalizeBrowserConfig(),'browser.exe',undefined,false,'invalid'),/route/);
});
test('browser route defaults to proxy and rejects invalid types or values', () => {
  assert.equal(validateBrowserRoute(),'proxy');
  assert.equal(validateBrowserRoute('direct'),'direct');
  for(const route of [null,'','DIRECT','invalid',false,0,{},[]]) assert.throws(()=>validateBrowserRoute(route),/route/);
});
test('navigation accepts only HTTP(S) or initial blank', () => {
  assert.equal(validatePageUrl(),'about:blank');
  assert.equal(validatePageUrl('https://example.test'),'https://example.test/');
  for (const url of ['javascript:alert(1)','file:///secret','data:text/html,x','http://u:p@host/']) assert.throws(()=>validatePageUrl(url));
});
test('one owned context per DSH session, navigation reuses, close removes temp profile', async () => {
  const contexts=[];
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:async()=>{const context=fakeBrowser();contexts.push(context);return context;}});
  try {
    assert.equal((await manager.run('one',{action:'status'})).state,'closed');
    const opened=await manager.run('one',{action:'open',url:'http://example.test'});
    assert.equal(opened.pages[0].url,'http://example.test/');
    const dir=manager.sessions.get('one').directory;
    await manager.run('one',{action:'open',url:'http://second.test'});
    assert.equal(contexts.length,1);
    await manager.run('two',{action:'open'});
    assert.equal(contexts.length,2);
    await manager.run('one',{action:'close'});
    await assert.rejects(access(dir));
    assert.equal((await manager.run('two',{action:'status'})).state,'open');
    assert.equal((await manager.run('one',{action:'close'})).state,'closed');
  } finally {await manager.dispose();}
  assert.equal(manager.sessions.size,0);
});
test('route switches replace profiles and omitted open/navigate always return to proxy', async () => {
  const contexts=[]; const directories=[]; const launchOptions=[]; let certificateCalls=0;
  const manager=new BurpBrowserManager({}, {
    certificate:async()=>{certificateCalls++;return certificate();},find:async()=>'/browser.exe',
    launch:async(directory,options)=>{
      if(directories.length) {assert.equal(contexts.at(-1).closed,true);await assert.rejects(access(directories.at(-1)));}
      directories.push(directory);launchOptions.push(options);const context=fakeBrowser();contexts.push(context);return context;
    },
  });
  try {
    const initial=await manager.run('one',{action:'open',url:'https://proxy.test'});
    assert.equal(initial.route,'proxy');assert.equal(initial.proxy,'http://127.0.0.1:8080');assert.equal(initial.tlsMode,'burp-ca-spki');
    const direct=await manager.run('one',{action:'navigate',url:'https://direct.test',route:'direct'});
    assert.equal(direct.route,'direct');assert.equal(direct.proxy,null);assert.equal(direct.tlsMode,'strict');assert.equal(direct.caFingerprint,null);
    assert.equal((await manager.run('one',{action:'status'})).route,'direct');
    assert.equal((await manager.run('one',{action:'navigate',url:'https://default.test'})).route,'proxy');
    await manager.run('one',{action:'open',route:'direct'});
    assert.equal((await manager.run('one',{action:'open'})).route,'proxy');
    assert.equal(contexts.length,5);assert.equal(new Set(directories).size,5);assert.equal(certificateCalls,3);
    assert.deepEqual(launchOptions.map(options=>Object.hasOwn(options,'proxy')),[true,false,true,false,true]);
    contexts[1].emit('close');await manager.tail;
    assert.equal(contexts[4].closed,undefined);
    assert.equal((await manager.run('one',{action:'status'})).route,'proxy');
  } finally {await manager.dispose();}
  for(const directory of directories) await assert.rejects(access(directory));
});
test('direct never requests Burp CA, strips environment proxies, and status/close keep its route', async () => {
  const keys=['HTTP_PROXY','https_proxy','ALL_PROXY','no_proxy'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys) process.env[key]='fixture-proxy';
  let options; let certificateCalls=0; const context=fakeBrowser();
  const manager=new BurpBrowserManager({browserExecutable:'/configured-browser.exe'}, {
    certificate:async()=>{certificateCalls++;throw new Error('must not request CA');},
    find:async configured=>{assert.equal(configured,'/configured-browser.exe');return configured;},
    launch:async(_directory,launchOptions)=>{options=launchOptions;return context;},
  });
  try {
    await assert.rejects(manager.run('one',{action:'navigate',url:'https://direct.test',route:'direct'}),/Open the Burp browser first/);
    const opened=await manager.run('one',{action:'open',route:'direct'});
    const directory=manager.sessions.get('one').directory;
    assert.equal(opened.route,'direct');assert.equal(opened.proxy,null);assert.equal(opened.tlsMode,'strict');
    assert.equal(certificateCalls,0);assert.equal(Object.hasOwn(options,'proxy'),false);
    assert.ok(options.args.includes('--no-proxy-server'));
    assert.equal(options.args.some(arg=>/--proxy-|ignore-certificate/.test(arg)),false);
    assert.equal(Object.keys(options.env).some(key=>/^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)),false);
    assert.equal((await manager.run('one',{action:'status'})).route,'direct');
    assert.deepEqual(await manager.run('one',{action:'close'}),{state:'closed',route:'direct',proxy:null,tlsMode:'strict'});
    assert.equal(context.closed,true);await assert.rejects(access(directory));
  } finally {
    await manager.dispose();
    for(const key of keys) {if(previous[key]===undefined) delete process.env[key];else process.env[key]=previous[key];}
  }
});
test('invalid routes are rejected before launch, status, or close', async () => {
  let launches=0;
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:async()=>{launches++;return fakeBrowser();}});
  try {
    for(const action of ['open','navigate','status','close']) {
      for(const route of [null,'invalid',false,3,{}]) await assert.rejects(manager.run('one',{action,url:'https://example.test',route}),/route/);
    }
    assert.equal(launches,0);
  } finally {await manager.dispose();}
});
test('route switch retains failed old-context cleanup and never launches its replacement', async () => {
  let launches=0; const context=fakeBrowser(); const normalClose=context.close;
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:async()=>{launches++;return context;}});
  try {
    await manager.run('one',{action:'open'});const record=manager.sessions.get('one');
    context.close=async()=>{throw new Error('close failed');};
    await assert.rejects(manager.run('one',{action:'open',route:'direct'}),/close failed/);
    assert.equal(launches,1);assert.equal(manager.sessions.get('one'),record);await access(record.directory);
  } finally {context.close=normalClose;await manager.dispose();}
});
test('a stale close event cannot close a newly opened replacement', async () => {
  const contexts=[];
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:async()=>{const context=fakeBrowser();contexts.push(context);return context;}});
  try {
    await manager.run('one',{action:'open'});
    const closing=manager.run('one',{action:'close'});
    const reopening=manager.run('one',{action:'open'});
    await Promise.all([closing,reopening]);
    await manager.tail;
    assert.equal(contexts.length,2);
    assert.equal(contexts[1].closed,undefined);
    assert.equal((await manager.run('one',{action:'status'})).state,'open');
  } finally {await manager.dispose();}
});
test('proxy check fails before browser launch; navigation never falls back', async () => {
  let launches=0;
  const manager=new BurpBrowserManager({}, {find:async()=>'/browser.exe',certificate:async()=>{throw new Error('proxy offline');},launch:async()=>{launches++;}});
  await assert.rejects(manager.run('one',{action:'open',url:'http://example.test'}),/proxy offline/);
  assert.equal(launches,0);
  await manager.dispose();
});
test('omitted route after direct fails closed when proxy is offline', async () => {
  let launches=0; const context=fakeBrowser();
  const manager=new BurpBrowserManager({}, {
    find:async()=>'/browser.exe',certificate:async()=>{throw new Error('proxy offline');},
    launch:async()=>{launches++;return context;},
  });
  try {
    await manager.run('one',{action:'open',route:'direct'});const directory=manager.sessions.get('one').directory;
    await assert.rejects(manager.run('one',{action:'navigate',url:'https://example.test'}),/proxy offline/);
    assert.equal(launches,1);assert.equal(context.closed,true);assert.equal(manager.sessions.size,0);
    await assert.rejects(access(directory));
    assert.equal((await manager.run('one',{action:'status'})).route,'proxy');
  } finally {await manager.dispose();}
});
test('abort during launch closes returned context and removes session', async () => {
  const controller=new AbortController(); const context=fakeBrowser();
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:async()=>{controller.abort();return context;}});
  await assert.rejects(manager.run('one',{action:'open'},controller.signal),/abort/i);
  assert.equal(context.closed,true); assert.equal(manager.sessions.size,0);
  await manager.dispose();
});
test('failed cleanup after launch abort remains tracked for disposal retry', async () => {
  const controller=new AbortController(); const context=fakeBrowser(); const normalClose=context.close; let count=0;
  context.close=async()=>{count++;if(count===1)throw new Error('close failed once');await normalClose();};
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:async()=>{controller.abort();return context;}});
  await assert.rejects(manager.run('one',{action:'open'},controller.signal),/cleanup incomplete/);
  assert.equal(manager.sessions.size,1);
  const dir=manager.sessions.get('one').directory;
  await manager.dispose();
  assert.equal(context.closed,true);assert.equal(manager.sessions.size,0);
  await assert.rejects(access(dir));
});
test('disposal waits in-flight launch, closes it, prevents future opens', async () => {
  let resolveLaunch; let didStart;
  const started=new Promise(resolve=>didStart=resolve); const context=fakeBrowser();
  const manager=new BurpBrowserManager({}, {certificate,find:async()=>'/browser.exe',launch:()=>{didStart();return new Promise(resolve=>resolveLaunch=resolve);}});
  const opening=manager.run('one',{action:'open'});
  await started;
  const disposing=manager.dispose();
  resolveLaunch(context);
  await assert.rejects(opening,/shutting down/);
  await disposing;
  assert.equal(context.closed,true);
  await assert.rejects(manager.run('one',{action:'open'}),/shutting down/);
});
test('browser tool registers, validates owner, and is withdrawn on disposal', async () => {
  const plugin=await import('../browser-plugin.js');
  const effects=[]; const definitions=new Map();
  const ctx={ effect(factory){effects.push(factory());},on(){},tools:{register(definition){definitions.set(definition.name,definition);return()=>definitions.delete(definition.name);}}};
  plugin.apply(ctx,{});
  const tool=definitions.get('burp_browser');
  assert.equal(tool.output.schema.type,'string');
  assert.deepEqual(tool.parameters.properties.route.enum,['proxy','direct']);
  assert.match(tool.parameters.properties.route.description,/only when the user explicitly requests/);
  await assert.rejects(tool.execute({action:'status',route:'invalid'},{agent:{id:'agent-a'},signal:new AbortController().signal}),/route/);
  await assert.rejects(tool.execute({action:'status'},{signal:new AbortController().signal}),/owning DSH/);
  const value=JSON.parse(await tool.execute({action:'status'},{agent:{id:'agent-a'},signal:new AbortController().signal}));
  assert.equal(value.state,'closed');
  for(const dispose of effects.reverse()) await dispose();
  assert.equal(definitions.size,0);
});
test('browser subpath resources and patch mount exist', async () => {
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.exports['./browser'],'./browser-plugin.js');
  assert.equal(pkg.exports['./browser/icon'],'./icon.svg');
  assert.equal(pkg.exports['./browser/locale/*.json'],'./browser-locale/*.json');
  for(const file of ['browser-plugin.js','browser-manager.js','browser-config.js']) {assert.ok(pkg.files.includes(file));await access(new URL('../'+file,import.meta.url));}
  const patch=await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8');
  assert.match(patch, /id: burp-proxy-browser/);
  assert.match(patch, /name: '@local\/dsh-burp-mcp\/browser'/);
});
