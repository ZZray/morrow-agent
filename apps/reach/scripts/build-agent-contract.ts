// Copyright (c) Ray Zhang. Generate the Rust-embedded contract from the service input schema.
import {readFileSync,writeFileSync} from 'node:fs';
import {agentToolContract} from '../src/contracts/agent-guidance.ts';
const target=new URL('../src/node/agent-tool-contract-v1.json',import.meta.url);
const bytes=JSON.stringify(agentToolContract(),null,2)+'\n';
if(process.argv.includes('--check')){
  if(readFileSync(target,'utf8')!==bytes)throw new Error('Embedded Agent tool contract drifted; run node scripts/build-agent-contract.ts');
}else writeFileSync(target,bytes);
