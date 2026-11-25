import {readdir,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
for(const entry of await readdir(root)){if(entry.endsWith('.js')||entry.endsWith('.mjs')){const result=spawnSync(process.execPath,['--check',path.join(root,entry)],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}}
for(const filename of ['index.js','config.js','gateway-config.js','mcp-gateway.js','mcp-gateway-main.mjs','browser-plugin.js','browser-config.js','browser-manager.js','http-transport.js','cordis.patch.yml','README.md','docs/USER_GUIDE.zh-CN.md','LICENSE','icon.svg'])await access(path.join(root,filename));
for(const dir of ['locale','browser-locale'])for(const filename of await readdir(path.join(root,dir))){const value=JSON.parse(await readFile(path.join(root,dir,filename),'utf8'));if(!value.meta?.title||!value.meta?.description)throw new Error('Missing display metadata');}
console.log('CHECK=pass; version='+pkg.version);
