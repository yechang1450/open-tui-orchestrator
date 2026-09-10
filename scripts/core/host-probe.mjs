import {spawnSync} from 'node:child_process';
// 主机 CLI 探测原语：冷启动/杀软扫描会偶发把单次 spawnSync 拖过 10s（实测后台引擎两次
// 在启动 ~11s 处因 --help 探测超时被误判 CLI_MISSING），因此对超时做有限重试；
// 确定性失败（非 0 退出、ENOENT 等）不重试。超时/次数可用 env 覆盖（测试与现场调优用）。
export function probeCli(bin,args,{env=process.env,timeoutMs,attempts}={}) {
  const t=Number(timeoutMs??env.ORCH_HOST_PROBE_TIMEOUT_MS)||10000;
  const n=Math.max(1,Math.floor(Number(attempts??env.ORCH_HOST_PROBE_ATTEMPTS)||2));
  let last;
  for(let i=0;i<n;i++){
    const r=spawnSync(bin,args,{env,encoding:'utf8',windowsHide:true,shell:false,timeout:t});
    last={status:r.status,error:r.error?String(r.error):null,stdout:String(r.stdout||''),stderr:String(r.stderr||''),out:String((r.stdout||'')+(r.stderr||''))};
    if(last.status===0)return last;
    if(!/ETIMEDOUT|timed out/i.test(last.error||''))return last;
  }
  return last;
}
