import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [output,workspace,nonce]=process.argv.slice(2);
assert.equal(path.resolve(process.cwd()),path.resolve(workspace));
const value={cwd:path.resolve(process.cwd()),nonce,ok:true};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(value),'utf8');
assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')),value);console.log(JSON.stringify(value));
