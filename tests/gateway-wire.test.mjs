import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const gatewayScript=fileURLToPath(new URL('../mcp-gateway-main.mjs',import.meta.url));
const inputSchema={type:'object',properties:{targetHostname:{type:'string'},targetPort:{type:'integer'},usesHttps:{type:'boolean'},content:{type:'string'}},required:['targetHostname','targetPort','usesHttps','content'],additionalProperties:false};
const definitions=[{name:'send_http1_request',inputSchema},{name:'send_http2_request',inputSchema:{type:'object'}},{name:'url_encode',inputSchema:{type:'object',properties:{content:{type:'string'}},required:['content']}}];

test('stdio MCP gateway: actual tool RPC defaults proxy, extension forwards, non-send retained',async()=>{
 let extensionCalls=0,proxyCalls=0;
 const upstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  if(req.method==='DELETE'){res.writeHead(200).end();return;}
  if(req.method==='GET'){res.writeHead(405).end();return;}
  const message=JSON.parse(Buffer.concat(chunks).toString());
  if(message.id===undefined){res.writeHead(202).end();return;}
  let result;
  if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake-burp',version:'1'}};
  else if(message.method==='tools/list')result={tools:definitions};
  else if(message.method==='tools/call'){
   if(['send_http1_request','send_http2_request'].includes(message.params.name)){extensionCalls++;assert.equal('route' in message.params.arguments,false);result={content:[{type:'text',text:'HTTP/1.1 200 OK\r\n\r\nextension'}]};}
   else result={content:[{type:'text',text:'encoded'}]};
  }else {res.writeHead(400).end();return;}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });
 const proxy=http.createServer((req,res)=>{proxyCalls++;assert.match(req.url,/^http:\/\//);res.end('proxy-response');});
 await Promise.all([new Promise(r=>upstream.listen(0,'127.0.0.1',r)),new Promise(r=>proxy.listen(0,'127.0.0.1',r))]);
 const transport=new StdioClientTransport({command:process.execPath,args:[gatewayScript,'--upstream',`http://127.0.0.1:${upstream.address().port}/mcp`,'--proxy',`http://127.0.0.1:${proxy.address().port}`],stderr:'pipe'});
 let stderr='';transport.stderr.on('data',chunk=>stderr+=chunk);
 const client=new Client({name:'wire-test',version:'1'},{capabilities:{},versionNegotiation:{mode:'auto'}});
 try{
  await client.connect(transport,{timeout:20000});
  const list=await client.listTools();assert.equal(list.tools.length,3);assert.equal(list.tools[0].inputSchema.properties.route.default,'proxy');
  const args={targetHostname:'example.test',targetPort:80,usesHttps:false,content:'GET /wire-default HTTP/1.1\r\nHost: example.test\r\n\r\n'};
  const p=await client.callTool({name:'send_http1_request',arguments:args});assert.match(p.content[0].text,/MCP route=proxy/);assert.equal(proxyCalls,1);assert.equal(extensionCalls,0);
  const e=await client.callTool({name:'send_http1_request',arguments:{...args,route:'extension'}});assert.match(e.content[0].text,/MCP route=extension/);assert.equal(extensionCalls,1);assert.equal(proxyCalls,1);
  const e2=await client.callTool({name:'send_http2_request',arguments:{pseudoHeaders:{':method':'GET',':path':'/'},headers:{},targetHostname:'example.test',targetPort:443,usesHttps:true,route:'extension'}});assert.match(e2.content[0].text,/MCP route=extension/);assert.equal(extensionCalls,2);
   const other=await client.callTool({name:'url_encode',arguments:{content:'test'}});assert.equal(other.content[0].text,'encoded');
  assert.equal(stderr,'');
 }finally{
  await client.close();upstream.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise(r=>upstream.close(r)),new Promise(r=>proxy.close(r))]);
 }
});
