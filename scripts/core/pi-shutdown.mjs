import fs from 'node:fs';
import path from 'node:path';
// Pi's settled event happens after automatic retries/compaction and queued work.
export default function orchestratorCompletion(pi) {
  pi.on('agent_settled',async(_event,ctx)=>{
    let file='',token='',tmp='',exit=1,text='',shouldShutdown=false;
    const persist=()=>{
      if(!file||!token)return;
      tmp=file+'.'+process.pid+'.tmp';
      try{
        fs.mkdirSync(path.dirname(file),{recursive:true});
        fs.writeFileSync(tmp,JSON.stringify({__EXIT__:exit,__DONE__:true,__REPORT__:text,token}));
        fs.renameSync(tmp,file);
      }catch(error){
        console.error(`PI_RESULT_WRITE_FAILED: ${error instanceof Error?error.message:String(error)}`);
      }finally{
        try{if(fs.existsSync(tmp))fs.rmSync(tmp,{force:true});}catch{}
      }
    };
    try{
      if(!ctx.isIdle())return;
      file=process.env.ORCH_PI_RESULT||'';token=process.env.ORCH_PI_TOKEN||'';
      if(!file||!token)return;
      shouldShutdown=true;
      try{
        const messages=ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='assistant');
        const last=messages.at(-1)?.message;
        text=(last?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
        const lastLine=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).at(-1)||'';
        exit=!['error','aborted'].includes(last?.stopReason)&&lastLine==='__ORCH_DONE__ '+token?0:1;
      }catch(error){
        text=`PI_COMPLETION_HANDLER_FAILED: ${error instanceof Error?error.message:String(error)}`;
      }
      persist();
    }catch(error){
      file=file||process.env.ORCH_PI_RESULT||'';token=token||process.env.ORCH_PI_TOKEN||'';
      text=`PI_COMPLETION_HANDLER_FAILED: ${error instanceof Error?error.message:String(error)}`;
      shouldShutdown=Boolean(file&&token);
      persist();
    }finally{
      if(shouldShutdown){
        try{await ctx.shutdown();}catch(error){console.error(`PI_SHUTDOWN_FAILED: ${error instanceof Error?error.message:String(error)}`);}
      }
    }
  });
}
