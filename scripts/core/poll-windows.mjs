import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {resolveRuntimeContext,runDirectory} from './runtime-context.mjs';
import {processSnapshot,sameProcess} from './leases.mjs';
import {TERMINAL,SUCCESS,summaryComplete} from './contracts.mjs';
export {TERMINAL,SUCCESS,summaryComplete};
export const summaryTerminal=sum=>summaryComplete(sum,false);
export const failures=sum=>Object.entries(sum?.taskResults||{}).filter(([,r])=>!SUCCESS.has(r.status)).map(([id,r])=>id+':'+r.status);
export function loadSummary(workspace,runId,stateDir){try{return JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,runId,stateDir),'summary.json'),'utf8'));}catch{return null;}}
export function parsePollingOptions(argv,env=process.env){
  const rawEngineExit=env.ORCH_ENGINE_EXIT;
  const envEngineExit=rawEngineExit===undefined||!String(rawEngineExit).trim()?null:Number(rawEngineExit);
  const result={runId:env.ORCH_RUN_ID,timeoutMs:1800000,intervalMs:5000,engineExit:envEngineExit,inline:false};
  const fields={'--run-id':'runId','--timeoutMs':'timeoutMs','--intervalMs':'intervalMs','--engine-exit':'engineExit'};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(flag==='--require-all-success')continue;
    if(flag==='--inline'){result.inline=true;continue;}
    const field=Object.hasOwn(fields,flag)?fields[flag]:null,value=argv[++i];
    if(!field||value===undefined||!String(value).trim()||String(value).startsWith('--'))throw new Error('POLL_ARGUMENT_INVALID: '+flag);
    result[field]=field==='runId'?value:Number(value);
  }
  if(!result.runId)throw new Error('POLL_ARGUMENT_INVALID: --run-id is required');
  for(const key of ['timeoutMs','intervalMs'])if(!Number.isSafeInteger(result[key])||result[key]<(key==='timeoutMs'?0:1)||result[key]>2147483647)throw new Error('POLL_ARGUMENT_INVALID: '+key);
  if(result.engineExit!==null&&(!Number.isSafeInteger(result.engineExit)||result.engineExit<0))throw new Error('POLL_ARGUMENT_INVALID: --engine-exit');
  result.intervalMs=Math.max(500,result.intervalMs);return result;
}
export async function main(argv=process.argv.slice(2),hooks={}) {
  const parsed=parsePollingOptions(argv);
  const {runId,timeoutMs,intervalMs:interval,engineExit,inline}=parsed;
  const observedEngineExit=hooks.engineExit===undefined?engineExit:hooks.engineExit;
  const {workspace,state}=resolveRuntimeContext();
  runDirectory(workspace,runId,state);
  const now=hooks.now||(()=>performance.now()),sleep=hooks.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  const snapshot=hooks.snapshot||processSnapshot,load=hooks.load||loadSummary,log=hooks.log||console.log,error=hooks.error||console.error;
  const deadline=now()+timeoutMs;
  let stable=0;
  while(now()<deadline) {
    const sum=load(workspace,runId,state);
    if(sum?.runId===runId&&sum.finishedAt&&summaryTerminal(sum)) {
      const ok=summaryComplete(sum,true);
      if(!ok){
        log(JSON.stringify({runId,success:false,failures:failures(sum)}));
        process.exitCode=1;return;
      }
      const remaining=deadline-now();if(remaining<=0)break;
      const processes=snapshot(Math.max(1,Math.ceil(remaining)));
      if(now()>=deadline)break;
      const alive=Object.values(sum.results).some(r=>r.launcher&&sameProcess(r.launcher,processes.get(r.launcher.ProcessId)));
      if(!alive&&++stable>=2){log(JSON.stringify({runId,success:true,failures:[]}));process.exitCode=0;return;}
      if(alive)stable=0;
    } else if(observedEngineExit!==null&&observedEngineExit!==0) {
      error('[poll-windows] engine-exit='+observedEngineExit+' without a successful finalized summary; not waiting for windows');
      process.exitCode=1;return;
    } else if(!sum && inline && observedEngineExit===0) {
      // An inline inventory is only a planning response; without a finalized run
      // summary it is not evidence that any task executed. Fail closed instead of
      // converting the missing execution into a successful poll result.
      error('[poll-windows] INLINE_NOT_EXECUTED: inline engine completed without a finalized run summary; no window execution was observed');
      process.exitCode=1;return;
    } else stable=0;
    log('[poll-windows] runId='+runId+' waiting for finalized inventory and closed windows');
    await sleep(Math.min(interval,Math.max(0,deadline-now())));
  }
  error('[poll-windows] timeout runId='+runId);process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(e=>{console.error(e.message);process.exitCode=2;});
