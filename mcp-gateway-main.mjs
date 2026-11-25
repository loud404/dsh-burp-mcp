import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BurpMcpGateway } from './mcp-gateway.js';

const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,array)=>{if(index%2===0)pairs.push([value.replace(/^--/,''),array[index+1]]);return pairs;},[]));
const upstreamUrl=new URL(args.upstream||'http://127.0.0.1:9876/mcp');
if(!['http:','https:'].includes(upstreamUrl.protocol)||upstreamUrl.username||upstreamUrl.password)throw new Error('Invalid upstream MCP URL');
const requestTimeoutMs=Number(args.timeout||120000);
const startupTimeoutMs=Number(args.startup||15000);
const maxResponseBytes=Number(args.maxResponseBytes||2097152);
if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1000||requestTimeoutMs>300000)throw new Error('Invalid request timeout');
const shutdown=new AbortController();
const gateways=new Set();const clients=new Set();
let handle;let closing;
const close=()=>closing??=(async()=>{
  shutdown.abort(new Error('Gateway transport closed'));
  await Promise.allSettled([...gateways].map(gateway=>gateway.dispose()));
  await Promise.allSettled([...clients].map(client=>client.close()));
  if(handle)await handle.close();
})();
process.stdin.on('end',()=>void close().catch(error=>console.error(error.message)));
process.stdin.on('close',()=>void close().catch(error=>console.error(error.message)));
process.on('SIGTERM',()=>void close().finally(()=>process.exit()));
process.on('SIGINT',()=>void close().finally(()=>process.exit()));

// SDK owns legacy/modern stdio negotiation, including the DSH probe process.
// No target request is sent until an MCP tools/call is received.
handle=serveStdio(async()=>{
  shutdown.signal.throwIfAborted();
  const client=new Client({name:'dsh-burp-routing-upstream',version:'1.3.1'},{capabilities:{},versionNegotiation:{mode:'legacy'},listMaxPages:32});
  clients.add(client);
  client.onerror=error=>console.error('Burp upstream:',error.message);
  const startup=AbortSignal.any([shutdown.signal,AbortSignal.timeout(startupTimeoutMs)]);
  try {
    await client.connect(new StreamableHTTPClientTransport(upstreamUrl),{signal:startup,timeout:startupTimeoutMs});
    if(!client.getServerCapabilities()?.tools)throw new Error('Upstream Burp MCP does not advertise tools');
    const listing=await client.listTools(undefined,{signal:startup,timeout:startupTimeoutMs});
    for(const name of ['send_http1_request','send_http2_request'])if(!listing.tools.some(tool=>tool.name===name))throw new Error('Upstream Burp MCP is missing required tool '+name);
    startup.throwIfAborted();
    const gateway=new BurpMcpGateway(client,listing.tools,{proxyUrl:args.proxy||'http://127.0.0.1:8080',requestTimeoutMs,maxResponseBytes});
    gateways.add(gateway);
    const server=gateway.createServer();
    const onclose=server.onclose;let intentionallyClosing=false;
    const upstreamClose=()=>{if(!intentionallyClosing&&!shutdown.signal.aborted)void close().finally(()=>process.exit(1));};
    client.onclose=upstreamClose;
    const originalPerform=gateway.perform.bind(gateway);
    gateway.perform=async(...params)=>{try{return await originalPerform(...params);}catch(error){
      if((!['send_http1_request','send_http2_request'].includes(params[0]?.name)||params[0]?.arguments?.route==='extension')&&/not connected|fetch failed|ECONNREFUSED|connection closed/i.test(error.message))upstreamClose();
      throw error;
    }};
    server.onclose=()=>{intentionallyClosing=true;onclose?.();void gateway.dispose().then(()=>{gateways.delete(gateway);clients.delete(client);},error=>console.error(error.message));};
    return server;
  } catch(error) {
    await client.close();clients.delete(client);throw error;
  }
},{transport:new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:12*1024*1024}),onerror:error=>console.error('MCP gateway:',error.message)});
