import { Server } from '@modelcontextprotocol/server';
import Ajv from 'ajv';
import { BurpHttpTransport } from './http-transport.js';

export const SEND_TOOLS = new Map([['send_http1_request', 'http1'], ['send_http2_request', 'http2']]);
export function routeForCall(value = 'proxy') {
  if (!['proxy', 'extension'].includes(value)) throw new Error('MCP HTTP route must be proxy or extension');
  return value;
}
export function gatewayTool(tool) {
  if (!SEND_TOOLS.has(tool.name)) return structuredClone(tool);
  const copy=structuredClone(tool);
  copy.inputSchema={...copy.inputSchema,properties:{...copy.inputSchema.properties,route:{type:'string',enum:['proxy','extension'],default:'proxy',description:'Default proxy: this MCP call sends via Burp Proxy. extension: this same MCP call uses the original Burp extension HTTP API (Logger), not a non-Burp direct request.'}}};
  copy.description='MCP-controlled HTTP request. Default route=proxy sends through Burp Proxy listener (Proxy history/Intercept settings). Set route=extension to use the original Burp extension HTTP API (Logger, original MCP HTTP approval). No automatic route fallback. '+(tool.description||'');
  // Proxy replies are normalized HTTP text, not arbitrary upstream structured output.
  delete copy.outputSchema;
  return copy;
}

export class BurpMcpGateway {
  constructor(upstream, tools, config={}, transport) {
    this.upstream=upstream;
    this.tools=new Map();this.validators=new Map();
    const ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});
    for(const tool of tools){
      if(this.tools.has(tool.name))throw new Error('Duplicate upstream MCP tool');
      const exposed=gatewayTool(tool);this.tools.set(tool.name,{original:tool,exposed});
      this.validators.set(tool.name,ajv.compile(exposed.inputSchema));
    }
    this.http=transport||new BurpHttpTransport(config);
    this.timeoutMs=config.requestTimeoutMs??120000;
    this.controller=new AbortController();this.pending=new Set();this.disposed=false;
  }
  list(){return {tools:[...this.tools.values()].map(value=>structuredClone(value.exposed))};}
  track(operation,signal) {
    if(this.disposed)return Promise.reject(new Error('MCP gateway is closing'));
    const combined=AbortSignal.any([this.controller.signal,...(signal?[signal]:[]),AbortSignal.timeout(this.timeoutMs)]);
    const work=Promise.resolve().then(()=>{combined.throwIfAborted();return operation(combined);});this.pending.add(work);
    work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
  }
  call(params,signal) {return this.track(combined=>this.perform(params,combined),signal);}
  async perform(params,signal) {
    signal.throwIfAborted();
    const tool=this.tools.get(params.name);if(!tool)throw new Error('Unknown MCP tool');
    const args=params.arguments??{};
    const validate=this.validators.get(params.name);
    if(!validate(args))throw new Error('Invalid MCP tool arguments: '+validate.errors.map(error=>error.instancePath+' '+error.message).join('; '));
    const protocol=SEND_TOOLS.get(params.name);
    if(!protocol)return this.upstream.callTool(params,{signal,timeout:this.timeoutMs,toolDefinition:tool.original});
    const route=routeForCall(args.route);
    const originalArgs={...args};delete originalArgs.route;
    if(route==='extension') {
      const result=await this.upstream.callTool({...params,arguments:originalArgs},{signal,timeout:this.timeoutMs,toolDefinition:tool.original});
      return {...result,content:[{type:'text',text:'[MCP route=extension; sender=Burp extension HTTP API; inspect=Logger; proxyListener=not-used]'},...(result.content??[])]};
    }
    const result=await this.http.send({...originalArgs,protocol,route:'proxy'},signal);
    return {content:[{type:'text',text:`[MCP route=proxy; sender=MCP gateway; proxy=${result.proxy}; clientProtocol=${result.protocol}; tlsMode=${result.tlsMode}]\nThis request was executed by an MCP tools/call handler through Burp Proxy. Proxy history/Intercept settings apply, not the extension HTTP approval dialog. Normalized UTF-8 HTTP response; original headers retained, bodyDecoded=${result.bodyDecoded}.\n${result.response}`} ]};
  }
  createServer() {
    const caps=this.upstream.getServerCapabilities?.()??{};
    const server=new Server({name:'burp-mcp-routing-gateway',version:'1.3.1'},{capabilities:{tools:{listChanged:false},...(caps.resources?{resources:{}}:{})},instructions:'Burp HTTP testing stays on MCP: use send_http1_request/send_http2_request. Omit route for proxy (default through Burp Proxy); use route=extension only for the original Burp extension HTTP API. extension is still sent by Burp, not a non-Burp direct connection. Other MCP tools are forwarded unchanged. Proxy uses Proxy Intercept/history settings; extension uses original Burp MCP HTTP approval and Logger. Never auto-fallback between routes.'});
    server.setRequestHandler('tools/list',()=>this.list());
    server.setRequestHandler('tools/call',async(request,context)=>{
      let result;
      try{result=await this.call(request.params,context.mcpReq.signal);}catch(error){result={isError:true,content:[{type:'text',text:error.message+'; no route fallback was made. A cancelled send may already have reached the target.'}]};}
      return server.projectCallToolResult(result,this.tools.get(request.params.name)?.exposed.outputSchema);
    });
    if(caps.resources){
      server.setRequestHandler('resources/list',(request,context)=>this.track(signal=>this.upstream.listResources(request.params,{signal,timeout:this.timeoutMs}),context.mcpReq.signal));
      server.setRequestHandler('resources/templates/list',(request,context)=>this.track(signal=>this.upstream.listResourceTemplates(request.params,{signal,timeout:this.timeoutMs}),context.mcpReq.signal));
      server.setRequestHandler('resources/read',(request,context)=>this.track(signal=>this.upstream.readResource(request.params,{signal,timeout:this.timeoutMs}),context.mcpReq.signal));
    }
    return server;
  }
  dispose(){
    if(this.closing)return this.closing;
    this.disposed=true;this.controller.abort(new Error('MCP gateway closing'));
    return this.closing=(async()=>{
      await this.http.dispose();await Promise.allSettled([...this.pending]);
      await this.upstream.close();
    })();
  }
}
