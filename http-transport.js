import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { normalizeBrowserConfig } from './browser-config.js';
import { proxyCertificate } from './browser-manager.js';

export function normalizeRoute(route = 'proxy') {
  if (!['proxy', 'direct'].includes(route)) throw new Error('route must be proxy or direct');
  return route;
}
function target(args) {
  if (typeof args.targetHostname !== 'string' || !args.targetHostname || /[\s/\\@?#\x00-\x1f]/.test(args.targetHostname)) throw new Error('targetHostname must be a host without a path or credentials');
  if (!Number.isInteger(args.targetPort) || args.targetPort < 1 || args.targetPort > 65535) throw new Error('targetPort must be 1..65535');
  if (typeof args.usesHttps !== 'boolean') throw new Error('usesHttps must be boolean');
  const bracketed=args.targetHostname.startsWith('[')&&args.targetHostname.endsWith(']');
  const host = bracketed?args.targetHostname.slice(1,-1):args.targetHostname;
  if(!host || /[\[\]]/.test(host) || (bracketed&&net.isIP(host)!==6) || (host.includes(':')&&net.isIP(host)!==6))throw new Error('Invalid targetHostname');
  const authority = `${net.isIP(host) === 6 ? '[' + host + ']' : host}:${args.targetPort}`;
  return { host, port: args.targetPort, secure: args.usesHttps, authority, origin: `${args.usesHttps ? 'https' : 'http'}://${authority}` };
}
export function parseHttp1(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('content must be a UTF-8 HTTP request up to 2 MiB');
  // Accept literal CRLF from model output only within the header prelude.
  let index = content.indexOf('\r\n\r\n'); let separator = 4;
  if (index < 0) {index = content.indexOf('\n\n'); separator = 2;}
  if (index < 0) {index = content.indexOf('\\r\\n\\r\\n'); separator = 8;}
  const prelude = (index < 0 ? content : content.slice(0,index)).replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/\r/g,'');
  const body = index < 0 ? '' : content.slice(index+separator);
  const lines = prelude.split('\n');
  const match = /^(\S+) (\S+) HTTP\/1\.[01]$/.exec(lines.shift());
  if (!match || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(match[1])) throw new Error('Invalid HTTP/1 request line');
  if (match[1].toUpperCase()==='CONNECT') throw new Error('HTTP CONNECT is not a normal request; use HTTPS mode for proxy tunneling');
  let requestPath = match[2];
  if (/^https?:\/\//.test(requestPath)) {const url = new URL(requestPath); requestPath = url.pathname + url.search;}
  if ((!requestPath.startsWith('/') && requestPath !== '*') || /[^\u0021-\u00ff]/.test(requestPath)) throw new Error('Use a valid percent-encoded origin-form request path');
  const headers=[];
  for (const line of lines) {
    if (!line) continue;
    const colon=line.indexOf(':');
    if (colon <= 0) throw new Error('Invalid HTTP header');
    const name=line.slice(0,colon);const value=line.slice(colon+1).trim();
    http.validateHeaderName(name);http.validateHeaderValue(name,value);
    if(name.toLowerCase()==='upgrade')throw new Error('HTTP Upgrade is not supported by the single-response HTTP tool');
    // Native HTTP owns framing. Never forward an inconsistent caller length or
    // Transfer-Encoding; no smuggling bytes may escape this request boundary.
    if (!['content-length','transfer-encoding','connection','proxy-connection'].includes(name.toLowerCase())) headers.push(name,value);
  }
  return {method:match[1],path:requestPath,headers,body:Buffer.from(body,'utf8')};
}
export function prepareHttp2(args, endpoint) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(args.pseudoHeaders) || !record(args.headers)) throw new Error('http2 requires pseudoHeaders and headers objects');
  if (typeof (args.requestBody ?? '') !== 'string' || Buffer.byteLength(args.requestBody ?? '') > 2 * 1024 * 1024) throw new Error('requestBody must be UTF-8 text up to 2 MiB');
  const headers = Object.create(null);
  for (const [key, value] of Object.entries(args.pseudoHeaders)) {
    const name = key.startsWith(':') ? key : ':' + key;
    if (![':method', ':path', ':scheme', ':authority'].includes(name) || name in headers || typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new Error('Invalid or duplicate HTTP/2 pseudo-header');
    headers[name] = value;
  }
  if (!headers[':method'] || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headers[':method'])) throw new Error('HTTP/2 :method is required');
  if(headers[':method'].toUpperCase()==='CONNECT')throw new Error('HTTP/2 CONNECT is not supported by this single-response tool');
  if (!headers[':path'] || !headers[':path'].startsWith('/') || /[\s\x00-\x1f]/.test(headers[':path'])) throw new Error('HTTP/2 origin-form :path is required');
  if (headers[':scheme'] && headers[':scheme'] !== 'https') throw new Error('HTTP/2 :scheme must match HTTPS');
  headers[':scheme'] = 'https';headers[':authority'] ??= endpoint.authority;
  if (!headers[':authority'] || /[\s/\\@?#\x00-\x1f]/.test(headers[':authority'])) throw new Error('Invalid HTTP/2 :authority');
  let bytes = 0;
  for (const [key, value] of Object.entries(args.headers)) {
    if (key.startsWith(':') || typeof value !== 'string') throw new Error('Place pseudo-headers in pseudoHeaders and use string header values');
    http.validateHeaderName(key);http.validateHeaderValue(key, value);
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > 65536) throw new Error('HTTP/2 headers exceed 64 KiB');
    if (!['connection','proxy-connection','transfer-encoding','keep-alive','upgrade','content-length','host'].includes(key.toLowerCase())) headers[key.toLowerCase()] = value;
  }
  const body=Buffer.from(args.requestBody ?? '', 'utf8');
  if(body.length)headers['content-length']=String(body.length);
  return {headers,body};
}
function scopeSignal(signal, timeoutMs) {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
}
async function waitSocket(socket,event,signal) {
  try { await once(socket,event,{signal}); return socket; } catch(error) {socket.destroy();throw error;}
}
async function connectTunnel(proxyUrl, endpoint, signal, sockets) {
  const proxy=new URL(proxyUrl);
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:proxy.hostname.replace(/^\[|\]$/g,''),port:Number(proxy.port||80),method:'CONNECT',path:endpoint.authority,headers:{Host:endpoint.authority},agent:false,signal});
    req.on('error',reject);
    req.on('connect',(response,socket,head)=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
      if(response.statusCode!==200){socket.destroy();reject(new Error(`Burp CONNECT returned HTTP ${response.statusCode}`));return;}
      if(head.length) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}
async function tlsSocket(raw, endpoint, alpn, ca, signal, sockets) {
  const checkIdentity=(_hostname,cert)=>{
    const error=tls.checkServerIdentity(endpoint.host,cert);
    // Older Burp CAs issue DNS:<literal IP> instead of iPAddress SANs.
    // Permit only that exact SAN on an already chain-validated Burp route.
    if(error && ca && net.isIP(endpoint.host) && cert.subjectaltname?.split(', ').includes('DNS:'+endpoint.host)) {
      if(new X509Certificate(cert.raw).checkHost(endpoint.host,{subject:'never'})===endpoint.host)return undefined;
    }
    return error;
  };
  const options={socket:raw,host:endpoint.host,rejectUnauthorized:true,checkServerIdentity:checkIdentity,ALPNProtocols:alpn,...(net.isIP(endpoint.host)?{}:{servername:endpoint.host}),...(ca?{ca}:{})};
  const socket=tls.connect(options);sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  const abort=()=>socket.destroy(signal.reason instanceof Error?signal.reason:new Error('Request aborted'));
  signal.addEventListener('abort',abort,{once:true});socket.once('close',()=>signal.removeEventListener('abort',abort));
  return waitSocket(socket,'secureConnect',signal);
}
async function bodyText(bytes, encoding) {
  const algorithms={gzip:zlib.gunzipSync,deflate:zlib.inflateSync,br:zlib.brotliDecompressSync};
  let result=bytes;let decoded=false;
  if(encoding && algorithms[encoding]) {result=algorithms[encoding](bytes,{maxOutputLength:4*1024*1024});decoded=true;}
  return {body:result.toString('utf8'),decoded};
}

export class BurpHttpTransport {
  constructor(config={}) {
    this.proxyUrl=normalizeBrowserConfig(config).proxyUrl;
    this.timeoutMs=config.requestTimeoutMs??120000;
    this.maxResponseBytes=config.maxResponseBytes??2097152;
    if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<1000||this.timeoutMs>300000)throw new Error('requestTimeoutMs must be 1000..300000');
    if(!Number.isInteger(this.maxResponseBytes)||this.maxResponseBytes<1024||this.maxResponseBytes>16777216)throw new Error('maxResponseBytes must be 1024..16777216');
    this.disposed=false;this.controllers=new Set();this.pending=new Set();this.sockets=new Set();
  }
  send(args,signal) {
    if(!args || typeof args!=='object' || Array.isArray(args))return Promise.reject(new Error('Request arguments must be an object'));
    if(this.disposed) return Promise.reject(new Error('Burp HTTP routing plugin is shutting down'));
    const controller=new AbortController();this.controllers.add(controller);
    const work=this.perform(args,scopeSignal(AbortSignal.any([controller.signal,...(signal?[signal]:[])]),this.timeoutMs));
    this.pending.add(work);
    const done=()=>{this.pending.delete(work);this.controllers.delete(controller);};
    work.then(done,done);return work;
  }
  async perform(args,signal) {
    signal.throwIfAborted();
    const route=normalizeRoute(args.route);const endpoint=target(args);const protocol=args.protocol??'http1';
    if(!['http1','http2'].includes(protocol)) throw new Error('protocol must be http1 or http2');
    if(protocol==='http2' && !endpoint.secure) throw new Error('HTTP/2 routing requires HTTPS; cleartext h2c is not downgraded to HTTP/1');
    const prepared=protocol==='http1'?parseHttp1(args.content):prepareHttp2(args,endpoint);
    let connection;let agent;let ca;
    const resources=new Set();
    const abortResources=()=>{for(const socket of resources)socket.destroy(signal.reason instanceof Error?signal.reason:new Error('Request aborted'));};
    signal.addEventListener('abort',abortResources,{once:true});
    const connectRaw=async()=>{
      const socket=route==='proxy'?await connectTunnel(this.proxyUrl,endpoint,signal,this.sockets):net.connect({host:endpoint.host,port:endpoint.port});
      resources.add(socket);this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));
      if(route==='direct')await waitSocket(socket,'connect',signal);
      signal.throwIfAborted();return socket;
    };
    try {
      if(route==='proxy' && endpoint.secure) {ca=(await proxyCertificate(this.proxyUrl,signal)).pem;}
      const collect = response => new Promise((resolve,reject)=>{
        const chunks=[];let count=0;
        response.on('data',chunk=>{count+=chunk.length;if(count>this.maxResponseBytes)response.destroy(new Error('Response exceeds maxResponseBytes'));else chunks.push(chunk);});
        response.on('error',reject);response.on('aborted',()=>reject(new Error('Response aborted')));
        response.on('close',()=>{if(!response.readableEnded)reject(new Error('Response closed before completion'));});
        response.on('end',()=>resolve(Buffer.concat(chunks)));
      });
      if(protocol==='http2') {
        const raw=await connectRaw();
        connection=await tlsSocket(raw,endpoint,['h2'],ca,signal,this.sockets);
        if(connection.alpnProtocol!=='h2') throw new Error('Peer did not negotiate HTTP/2; no protocol downgrade or direct retry was made');
        const session=http2.connect(endpoint.origin,{createConnection:()=>connection});
        session.on('error',()=>{});
        const close=()=>session.destroy();signal.addEventListener('abort',close,{once:true});
        try {
          const exchange=await new Promise((resolve,reject)=>{
            const stream=session.request(prepared.headers,{endStream:false});let responseHeaders;const chunks=[];let count=0;
            const fail=error=>reject(error instanceof Error?error:new Error(String(error)));
            session.once('error',fail);session.once('close',()=>fail(new Error('HTTP/2 session closed')));
            session.once('goaway',()=>fail(new Error('HTTP/2 session sent GOAWAY before completion')));
            stream.once('response',headers=>{responseHeaders=headers;});
            stream.on('data',chunk=>{count+=chunk.length;if(count>this.maxResponseBytes){stream.destroy(new Error('Response exceeds maxResponseBytes'));}else chunks.push(chunk);});
            stream.once('error',fail);stream.once('aborted',()=>fail(new Error('HTTP/2 stream aborted')));
            stream.once('close',()=>{if(!stream.readableEnded)fail(new Error('HTTP/2 stream closed before completion'));});
            stream.once('end',()=>{if(!responseHeaders)fail(new Error('HTTP/2 ended without response'));else resolve({headers:responseHeaders,bytes:Buffer.concat(chunks)});});
            stream.end(prepared.body);
          });
          const responseHeaders=exchange.headers;const text=await bodyText(exchange.bytes,responseHeaders['content-encoding']);
          const status=responseHeaders[':status'];
          const response=`HTTP/2 ${status}\r\n`+Object.entries(responseHeaders).filter(([key])=>!key.startsWith(':')).map(([key,value])=>`${key}: ${value}`).join('\r\n')+'\r\n\r\n'+text.body;
          return {route,proxy:route==='proxy'?this.proxyUrl:null,protocol:'http2',tlsMode:route==='proxy'?'burp-ca+literal-ip-dns-san-compat':'strict',response,bodyDecoded:text.decoded};
        } finally {signal.removeEventListener('abort',close);session.destroy();}
      }
      const request=prepared;
      if(!request.headers.some((value,index)=>index%2===0 && value.toLowerCase()==='host')) request.headers.push('Host',endpoint.authority);
      request.headers.push('Connection','close','Content-Length',String(request.body.length));
      let host=endpoint.host,port=endpoint.port,requestPath=request.path;
      if(route==='proxy' && !endpoint.secure){const proxy=new URL(this.proxyUrl);host=proxy.hostname.replace(/^\[|\]$/g,'');port=Number(proxy.port||80);requestPath=endpoint.origin+request.path;}
      if(endpoint.secure){
        const raw=await connectRaw();
        connection=await tlsSocket(raw,endpoint,['http/1.1'],ca,signal,this.sockets);
        agent=new http.Agent({keepAlive:false});agent.createConnection=()=>connection;
      }
      const result=await new Promise((resolve,reject)=>{
        const req=http.request({hostname:host,port,path:requestPath,method:request.method,headers:request.headers,agent:agent||false,signal},async response=>{
          try {
            const bytes=await collect(response);const text=await bodyText(bytes,response.headers['content-encoding']);
            const prelude=`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`+response.rawHeaders.reduce((lines,value,index)=>{if(index%2===0)lines.push(value+': '+response.rawHeaders[index+1]);return lines;},[]).join('\r\n');
            resolve({route,proxy:route==='proxy'?this.proxyUrl:null,protocol:'http1',tlsMode:endpoint.secure?(route==='proxy'?'burp-ca+literal-ip-dns-san-compat':'strict'):'none',response:prelude+'\r\n\r\n'+text.body,bodyDecoded:text.decoded});
          } catch(error){reject(error);}
        });
        req.on('socket',socket=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));});
        req.on('upgrade',(_response,socket)=>{socket.destroy();reject(new Error('HTTP Upgrade responses are not supported'));});
        req.on('connect',(_response,socket)=>{socket.destroy();reject(new Error('Unexpected CONNECT response'));});
        req.on('error',reject);req.end(request.body);
      });
      return result;
    } catch(error) {
      signal.throwIfAborted();
      throw new Error(`${route === 'proxy'?'Burp Proxy':'Direct'} HTTP request failed: ${error.message}. No automatic route fallback was made.`,{cause:error});
    } finally {signal.removeEventListener('abort',abortResources);agent?.destroy();connection?.destroy();for(const socket of resources)socket.destroy();}
  }
  async dispose(){
    this.disposed=true;for(const controller of this.controllers)controller.abort(new Error('Burp HTTP routing unloaded'));
    for(const socket of this.sockets)socket.destroy();await Promise.allSettled([...this.pending]);
  }
}
