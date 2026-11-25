import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/configure.mjs',import.meta.url));
test('configuration help and invalid options do not change the bundle',async()=>{
 const target=new URL('../cordis.patch.yml',import.meta.url);const before=await readFile(target,'utf8');
 const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8'});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--node/);
 const invalid=spawnSync(process.execPath,[script,'--unknown','x'],{encoding:'utf8'});assert.notEqual(invalid.status,0);
 const directory=spawnSync(process.execPath,[script,'--node',fileURLToPath(new URL('../',import.meta.url))],{encoding:'utf8'});assert.notEqual(directory.status,0);assert.match(directory.stderr,/executable file/);
 assert.equal(await readFile(target,'utf8'),before);
});
