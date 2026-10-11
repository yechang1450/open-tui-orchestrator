import {spawnSync} from 'node:child_process';
// 主机 CLI 探测原语：冷启动/杀软扫描会偶发把单次 spawnSync 拖过 10s（实测后台引擎两次
// 在启动 ~11s 处因 --help 探测超时被误判 CLI_MISSING），因此对超时做有限重试；
// 确定性失败（非 0 退出、ENOENT 等）不重试。超时/次数可用 env 覆盖（测试与现场调优用）。
// timeoutMs <= 0、非数值和 Infinity 都是无效边界，回退默认值；0 不表示禁用超时。
const DEFAULT_PROBE_TIMEOUT_MS=10000;
const MAX_PROBE_TIMEOUT_MS=120000;
// ANSI 剥离（2026-10-11）：--help 在 FORCE_COLOR/PTY 继承下可能带色（pi 实测），校验消费处
// 按纯文本匹配，先剥 CSI 转义序列（与 pi-host 同款形态）；stdout/stderr 原文保留。
const ANSI_ESCAPE=new RegExp(String.fromCharCode(27)+'[[]'+'[0-?]*'+'[ -/]*'+'[@-~]','g');
export function plainText(value){return String(value||'').replace(ANSI_ESCAPE,'');}
export function normalizeProbeTimeout(rawTimeout,defaultMs=DEFAULT_PROBE_TIMEOUT_MS,maxMs=MAX_PROBE_TIMEOUT_MS) {
  const value=Number(rawTimeout);
  return rawTimeout===undefined||rawTimeout===''||!Number.isFinite(value)||value<=0
    ? defaultMs
    : Math.min(maxMs,Math.floor(value));
}
export function probeCli(bin,args,{env=process.env,timeoutMs,attempts}={}) {
  const rawTimeout=timeoutMs??env.ORCH_HOST_PROBE_TIMEOUT_MS;
  const rawAttempts=attempts??env.ORCH_HOST_PROBE_ATTEMPTS;
  const attemptValue=Number(rawAttempts);
  const t=normalizeProbeTimeout(rawTimeout);
  const n=rawAttempts===undefined||rawAttempts===''?2:Number.isFinite(attemptValue)?Math.max(1,Math.min(5,Math.floor(attemptValue))):2;
  // .cmd/.bat 不能直接 spawn（CreateProcess 无法执行批处理，实测 EINVAL）——与 install-deps.mjs 同一形态：
  // 走 cmd /d /s /c 的 verbatim 形态（整条命令外加一对引号 + windowsVerbatimArguments）。
  // 不修这一条，npm 全局装出来的宿主 CLI（Windows 上就是 .cmd shim）会被永久判成「没有可用的 CLI」：
  // 实测 hermes 现场 4 个候选里两个 .cmd 全部 EINVAL，而 EINVAL 不是超时、不会被重试。
  const isBatch=process.platform==='win32'&&/\.(cmd|bat)$/i.test(String(bin));
  // 只给「确实需要」的参数加引号：批处理里 `%1` 会连引号一起拿到，把 `--help` 写成 `"--help"`
  // 会让 `if "%1"=="--help"` 这类比较永远不成立。bin 一律加引号（路径常含空格）。
  const q=s=>/[\s&|<>^"]/.test(String(s))?'"'+String(s)+'"':String(s);
  // 宽列探测（2026-10-11）：窄终端下列宽敏感的 CLI 会省略旗标（kimi 实测 80 列丢 --auto、
  // COLUMNS=200 全量）；默认注入 200 列，调用者显式设置的 COLUMNS 优先。
  const probeEnv=env&&env.COLUMNS!==undefined?env:{COLUMNS:'200',...env};
  let last;
  for(let i=0;i<n;i++){
    const r=isBatch
      ? spawnSync(probeEnv.ComSpec||'cmd.exe',['/d','/s','/c','""'+String(bin)+'" '+args.map(q).join(' ')+'"'],
          {env:probeEnv,encoding:'utf8',windowsHide:true,shell:false,timeout:t,windowsVerbatimArguments:true})
      : spawnSync(bin,args,{env:probeEnv,encoding:'utf8',windowsHide:true,shell:false,timeout:t});
    last={status:r.status,error:r.error?String(r.error):null,stdout:String(r.stdout||''),stderr:String(r.stderr||''),out:plainText(String((r.stdout||'')+(r.stderr||'')))};
    if(last.status===0)return last;
    if(!/ETIMEDOUT|timed out/i.test(last.error||''))return last;
  }
  return last;
}
