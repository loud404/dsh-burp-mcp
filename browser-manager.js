import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { X509Certificate, createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { normalizeBrowserConfig, validatePageUrl, validateBrowserRoute, browserLaunchOptions } from './browser-config.js';

function aborted(signal) { signal?.throwIfAborted(); }

export async function findBrowser(configured = '') {
  const candidates = configured ? [configured] : process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Set browserExecutable to an installed Google Chrome or Chromium executable');
}

export async function proxyCertificate(proxyUrl, signal) {
  aborted(signal);
  const proxy = new URL(proxyUrl);
  const bytes = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port || 80), path: 'http://burp/cert', method: 'GET', headers: { Host: 'burp', Connection: 'close' }, timeout: 4000, signal }, response => {
      const chunks = []; let count = 0;
      response.on('data', chunk => { count += chunk.length; if (count > 65536) req.destroy(new Error('Burp CA response exceeds 64 KiB')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => response.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Burp Proxy certificate check returned HTTP ${response.statusCode}`)));
    });
    req.on('timeout', () => req.destroy(new Error('Burp Proxy did not answer; check its listener and Intercept state')));
    req.on('error', reject); req.end();
  });
  const certificate = new X509Certificate(bytes);
  if (!certificate.ca || !/PortSwigger/i.test(certificate.subject)) throw new Error('The proxy did not supply a Burp CA certificate');
  return {
    spki: createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    fingerprint: certificate.fingerprint256,
    pem: certificate.toString(),
  };
}

function browserEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|PASSWORD|SECRET|TOKEN|^DSH_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)));
}

export class BurpBrowserManager {
  constructor(config = {}, options = {}) {
    this.config = normalizeBrowserConfig(config);
    this.launch = options.launch || ((directory, launchOptions) => chromium.launchPersistentContext(directory, launchOptions));
    this.find = options.find || findBrowser;
    this.certificate = options.certificate || proxyCertificate;
    this.headless = options.headless ?? false; // Tests only; not exposed through the agent tool.
    this.sessions = new Map();
    this.tail = Promise.resolve();
    this.disposed = false;
  }

  serial(work) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  run(owner, args = {}, signal) {
    return this.serial(async () => {
      aborted(signal);
      if (this.disposed) throw new Error('Burp browser plugin is shutting down');
      if (!owner) throw new Error('Burp browser needs an owning DSH session');
      const action = args.action;
      if (!['open', 'navigate', 'status', 'close'].includes(action)) throw new Error('Choose open, navigate, status, or close');
      const route = validateBrowserRoute(args.route);
      if (action === 'close') {
        const { route, proxy, tlsMode } = this.snapshot(owner);
        await this.closeOwner(owner);
        return { state: 'closed', route, proxy, tlsMode };
      }
      if (action === 'status') return this.snapshot(owner);
      const url = validatePageUrl(args.url ?? (action === 'open' ? 'about:blank' : ''));
      let record = this.sessions.get(owner);
      if (!record && action !== 'open') throw new Error('Open the Burp browser first');
      if (record && !record.closed && record.route !== route) {
        await this.closeOwner(owner, record);
        record = undefined;
        aborted(signal);
      }
      let created = false;
      if (!record) {
        const executable = await this.find(this.config.browserExecutable);
        // Proxy mode verifies Burp before navigation; direct mode never contacts it.
        const ca = route === 'proxy' ? await this.certificate(this.config.proxyUrl, signal) : null;
        aborted(signal);
        const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-burp-browser-'));
        let context;
        try {
          const useBurpCA = route === 'proxy' && this.config.trustBurpCA;
          context = await this.launch(directory, { ...browserLaunchOptions(this.config, executable, useBurpCA ? ca.spki : undefined, this.headless, route), env: browserEnvironment() });
          record = { context, directory, executable, route, tlsMode: useBurpCA ? 'burp-ca-spki' : 'strict', caFingerprint: useBurpCA ? ca.fingerprint : null, closed: false };
          this.sessions.set(owner, record);
          context.on('close', () => {
            record.closed = true;
            void this.serial(() => this.closeOwner(owner, record)).catch(error => console.error('Burp browser cleanup:', error.message));
          });
          created = true;
          aborted(signal);
          if (this.disposed) throw new Error('Burp browser plugin is shutting down');
        } catch (error) {
          try {
            if (record && this.sessions.get(owner) === record) await this.closeOwner(owner, record);
            else {
              if (context) await context.close();
              await rm(directory, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Burp browser launch failed; cleanup incomplete and retained for retry');
          }
          throw error;
        }
      }
      if (record.closed) {
        await this.closeOwner(owner);
        throw new Error('The dedicated browser was closed; use open to create a fresh window');
      }
      const onAbort = () => { void record.context.close().catch(() => {}); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const pages = record.context.pages();
        const page = pages.at(-1) || await record.context.newPage();
        if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.browserTimeoutMs });
        await page.bringToFront();
        aborted(signal);
        if (record.closed) throw new Error('The dedicated browser closed during navigation');
        return this.snapshot(owner);
      } catch (error) {
        if (created || signal?.aborted) await this.closeOwner(owner);
        aborted(signal);
        const routingAdvice = route === 'proxy' ? 'Check Burp Proxy/Intercept; no direct retry was made.' : 'No proxy retry was made.';
        throw new Error(`Burp browser navigation failed: ${error.message}. ${routingAdvice}`, { cause: error });
      } finally { signal?.removeEventListener('abort', onAbort); }
    });
  }

  snapshot(owner) {
    const record = this.sessions.get(owner);
    const route = record?.route ?? 'proxy';
    const routing = { route, proxy: route === 'proxy' ? this.config.proxyUrl : null, tlsMode: record?.tlsMode ?? (this.config.trustBurpCA ? 'burp-ca-spki' : 'strict') };
    if (!record || record.closed) return { state: 'closed', ...routing };
    return {
      state: 'open', ...routing,
      executable: record.executable,
      temporaryProfile: true,
      caFingerprint: record.caFingerprint,
      pages: record.context.pages().map(page => ({ url: page.url() })),
      routing: route === 'proxy'
        ? 'Dedicated window HTTP/HTTPS and WS/WSS use Burp Proxy; no DIRECT fallback. Not a system-wide or all-protocol network boundary.'
        : 'Dedicated window connects directly with proxy disabled and normal certificate validation.',
    };
  }

  async closeOwner(owner, expectedRecord) {
    const record = this.sessions.get(owner);
    if (!record || (expectedRecord && record !== expectedRecord)) return;
    await record.context.close();
    await rm(record.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    this.sessions.delete(owner);
  }

  dispose() {
    this.disposed = true;
    return this.serial(async () => {
      const results = await Promise.allSettled([...this.sessions.keys()].map(owner => this.closeOwner(owner)));
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Burp browser cleanup incomplete');
    });
  }
}
