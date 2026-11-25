import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BurpMcpGateway, gatewayTool, routeForCall } from '../mcp-gateway.js';
const tools=[{name:'send_http1_request',description:'HTTP1',inputSchema:{type:'object',properties:{targetHostname:{type:'string'},targetPort:{type:'integer'},usesHttps:{type:'boolean'},content:{type:'string'}},required:['targetHostname','targetPort','usesHttps','content'],additionalProperties:false}},{name:'generate_random_string',description:'random',inputSchema:{type:'object',properties:{length:{type:'integer'}},required:['length']}}];
const args={targetHostname:'localhost',targetPort:80,usesHttps:false,content:'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'};
function fixture(send=async()=>({proxy:'http://127.0.0.1:8080',protocol:'http1',tlsMode:'none',bodyDecoded:false,response:'HTTP/1.1 200 OK\r\n\r\nproxy'})){
 const forwarded=[];const sent=[];
 const upstream={callTool:async(params)=>{forwarded.push(params);return {content:[{type:'text',text:'extension-response'}],_meta:{original:true}};},close:async()=>{},getServerCapabilities:()=>({tools:{}})};
 const http={send:async(...params)=>{sent.push(params);return send(...params);},dispose:async()=>{}};
 return {gateway:new BurpMcpGateway(upstream,tools,{},http),forwarded,sent};
}
test('MCP schema retains names and adds only proxy/extension route to HTTP tools',()=>{
 const send=gatewayTool(tools[0]);assert.equal(send.name,tools[0].name);assert.deepEqual(send.inputSchema.properties.route.enum,['proxy','extension']);assert.equal(send.inputSchema.properties.route.default,'proxy');assert.deepEqual(gatewayTool(tools[1]),tools[1]);assert.equal(routeForCall(),'proxy');assert.throws(()=>routeForCall('direct'));
});
test('one MCP call defaults proxy; explicit extension goes to original API without route',async()=>{
 const {gateway,forwarded,sent}=fixture();
 try{
  const proxy=await gateway.call({name:'send_http1_request',arguments:args});assert.match(proxy.content[0].text,/MCP route=proxy/);assert.equal(sent.length,1);assert.equal(forwarded.length,0);
  const ext=await gateway.call({name:'send_http1_request',arguments:{...args,route:'extension'}});assert.match(ext.content[0].text,/MCP route=extension/);assert.deepEqual(forwarded[0].arguments,args);assert.equal(sent.length,1);assert.equal(ext._meta.original,true);
  await gateway.call({name:'generate_random_string',arguments:{length:3}});assert.equal(forwarded[1].name,'generate_random_string');
 }finally{await gateway.dispose();}
});
test('proxy failure does not fallback; invalid route and missing input send nothing',async()=>{
 const {gateway,forwarded,sent}=fixture(async()=>{throw new Error('proxy offline');});
 try{
  await assert.rejects(gateway.call({name:'send_http1_request',arguments:args}),/offline/);assert.equal(forwarded.length,0);
  await assert.rejects(gateway.call({name:'send_http1_request',arguments:{...args,route:'direct'}}),/Invalid MCP tool/);
  await assert.rejects(gateway.call({name:'send_http1_request',arguments:{route:'extension'}}),/Invalid MCP tool/);assert.equal(sent.length,1);
 }finally{await gateway.dispose();}
});
test('SDK MCP tools/call actually crosses a protocol transport for both routes',async()=>{
 const {gateway}=fixture();const server=gateway.createServer();const client=new Client({name:'wire-test',version:'1'},{capabilities:{}});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(st);await client.connect(ct);
  const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name),tools.map(t=>t.name));
  const p=await client.callTool({name:'send_http1_request',arguments:args});assert.match(p.content[0].text,/MCP route=proxy/);
  const e=await client.callTool({name:'send_http1_request',arguments:{...args,route:'extension'}});assert.match(e.content[0].text,/MCP route=extension/);
 }finally{await client.close();await server.close();await gateway.dispose();}
});
test('non-sending MCP results preserve error, structured content and metadata',async()=>{
 const {gateway}=fixture();const expected={isError:true,content:[{type:'text',text:'denied'}],structuredContent:{status:'denied'},_meta:{unchanged:true}};gateway.upstream.callTool=async()=>expected;
 try{assert.deepEqual(await gateway.call({name:'generate_random_string',arguments:{length:1}}),expected);}finally{await gateway.dispose();}
});
test('resources forward through MCP and shared disposal aborts a pending read',async()=>{
 const {gateway}=fixture();gateway.upstream.getServerCapabilities=()=>({tools:{},resources:{}});
 gateway.upstream.listResources=async()=>({resources:[{uri:'test://one',name:'one'}]});gateway.upstream.listResourceTemplates=async()=>({resourceTemplates:[]});
 gateway.upstream.readResource=async(params,{signal})=>params.uri==='test://one'?{contents:[{uri:params.uri,text:'resource'}]}:new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 const server=gateway.createServer(),client=new Client({name:'resource-test',version:'1'},{capabilities:{}});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{await server.connect(st);await client.connect(ct);assert.equal((await client.listResources()).resources[0].uri,'test://one');assert.equal((await client.readResource({uri:'test://one'})).contents[0].text,'resource');
 const pending=client.readResource({uri:'test://pending'});const rejection=assert.rejects(pending);await new Promise(resolve=>setImmediate(resolve));const first=gateway.dispose();assert.equal(gateway.dispose(),first);await first;await rejection;
 }finally{await client.close();await server.close();await gateway.dispose();}
});
test('MCP wire cancellation reaches request signal and preserves another call',async()=>{
 const {gateway}=fixture((_args,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({proxy:'p',protocol:'http1',response:'ok'}),75);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});}));
 const server=gateway.createServer(),client=new Client({name:'cancel-wire',version:'1'},{capabilities:{}});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{await server.connect(st);await client.connect(ct);await client.listTools();const controller=new AbortController();const failed=client.callTool({name:'send_http1_request',arguments:args},{signal:controller.signal});const rejected=assert.rejects(failed);const other=client.callTool({name:'send_http1_request',arguments:args});controller.abort(new Error('wire cancel'));await rejected;assert.match((await other).content[0].text,/route=proxy/);}finally{await client.close();await server.close();await gateway.dispose();}
});
test('cancel one MCP request without cancelling another',async()=>{
 const {gateway}=fixture((_args,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({proxy:'p',protocol:'http1',response:'ok'}),50);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});}));
 try{
  const controller=new AbortController();const cancelled=gateway.call({name:'send_http1_request',arguments:args},controller.signal);const other=gateway.call({name:'send_http1_request',arguments:args});const failed=assert.rejects(cancelled);controller.abort(new Error('test cancel'));await failed;assert.match((await other).content[0].text,/route=proxy/);
 }finally{await gateway.dispose();}
});
