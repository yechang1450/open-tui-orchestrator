param([Parameter(Mandatory=$true)][string]$Payload, [switch]$Activate)
$ErrorActionPreference='Stop'
# Starts a program with no-activate semantics, and (with -Activate) makes the new window
# actually reach the user's eyes: raise it to the front of the z-order, ask for the
# foreground, and report a machine-readable verdict on stdout.
#
# Why this exists (measured 2026-09-17): a spawned Windows Terminal window was visible and
# normal-sized but NEVER activated, and the old helper actively pushed the previous
# foreground window back to the front for 2.5s. Result: windows opened behind whatever the
# user was looking at, so "visible TUI window" mode was invisible in practice. The verdict
# printed here is the evidence the engine now requires before it may claim a popup.
try {
  $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OrchestratorInactiveShell {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Startup {
  public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
  public short show,reserved2;public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int L,T,R,B;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool CreateProcessW(string app,System.Text.StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle,int cmd);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr handle,int cmd);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle,out Rect r);
 [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr handle,bool altTab);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach,uint attachTo,bool fAttach);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr handle);
 [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FlashInfo info);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [StructLayout(LayoutKind.Sequential)] public struct FlashInfo {public uint cbSize;public IntPtr hwnd;public uint flags,count,timeout;}
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
 delegate bool EnumProc(IntPtr h,IntPtr p);
 static readonly IntPtr HWND_TOPMOST=new IntPtr(-1), HWND_NOTOPMOST=new IntPtr(-2);
 static readonly uint SWP_NOMOVE=0x2, SWP_NOSIZE=0x1, SWP_SHOWWINDOW=0x40;
 static void Snapshot(HashSet<IntPtr> set){EnumWindows((h,p)=>{if(IsWindowVisible(h))set.Add(h);return true;},IntPtr.Zero);}
 public static string Title(IntPtr h){var n=GetWindowTextLength(h);if(n<=0)return "";var sb=new StringBuilder(n+1);GetWindowText(h,sb,sb.Capacity);return sb.ToString();}
 // z-order rank (0 = frontmost): EnumWindows walks top-level windows in z-order, so this is the
 // hardest measurable evidence that the user can actually see the window. -1 = not found.
 static int ZRank(IntPtr target){int rank=0;int found=-1;EnumWindows((h,p)=>{if(found>=0)return false;if(h==target){found=rank;return false;}rank++;return rank<400;},IntPtr.Zero);return found;}
 // Launch (no activate) and optionally bring the fresh window forward. Prints one JSON line.
 public static string Launch(string file,string parameters,string cwd,bool activate){
  HashSet<IntPtr> before=null;
  if(activate){before=new HashSet<IntPtr>();Snapshot(before);}
  var s=new Startup();s.cb=Marshal.SizeOf(s);s.flags=1;s.show=4;ProcessInfo p;
  if(!CreateProcessW(file,new System.Text.StringBuilder("\""+file+"\" "+parameters),IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,cwd,ref s,out p))
    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  CloseHandle(p.thread);CloseHandle(p.process);
  if(!activate)return "{\"ok\":true,\"activated\":false}";
  // Give the app time to create its window, then raise the first fresh, sane top-level window.
  var deadline=Environment.TickCount64+9000;
  IntPtr found=IntPtr.Zero; string title="";
  while(Environment.TickCount64<deadline){
    var now=new HashSet<IntPtr>();Snapshot(now);
    foreach(var h in now){
      if(before.Contains(h))continue;
      uint windowPid=0;if(GetWindowThreadProcessId(h,out windowPid)==0||windowPid!=p.pid)continue;
      if(!IsWindowVisible(h))continue;
      Rect r;if(!GetWindowRect(h,out r))continue;
      var w=r.R-r.L;var hh=r.B-r.T;
      if(w<260||hh<180)continue;                     // skip IME/tool/tray slivers
      var t=Title(h);
      if(t=="MSCTFIME UI"||t=="Default IME"||t=="DDE Server Window")continue;
      found=h;title=t;break;
    }
    if(found!=IntPtr.Zero)break;
    System.Threading.Thread.Sleep(150);
  }
  if(found==IntPtr.Zero)return "{\"ok\":false,\"reason\":\"no new visible window appeared within 9000ms\"}";
  Rect fr;GetWindowRect(found,out fr);
  ShowWindow(found,1);ShowWindowAsync(found,1);      // SW_SHOWNORMAL twice: restore if minimized
  SetWindowPos(found,HWND_TOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW);
  SetWindowPos(found,HWND_NOTOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW);
  AllowSetForegroundWindow(-1);
  // A background process is normally denied the foreground. The attach-thread-input trick borrows the
  // foreground thread's input queue for one SetForegroundWindow call, which Windows does allow.
  // 2026-09-18 (pi battery): with several windows spawning back-to-back a sibling spawn can steal the
  // foreground right after our switch, leaving this window visible but not in front. Retry the
  // activation up to 3 times; the last check is what the verdict reports.
  var fg=false;var isFg=false;var visible=false;var minimized=false;var zrank=-1;
  for(var attempt=0;attempt<3;attempt++){
    var fgw=GetForegroundWindow();
    uint fgThread=0;uint fgThreadDummy=0;if(fgw!=IntPtr.Zero)fgThread=GetWindowThreadProcessId(fgw,out fgThreadDummy);
    var thisThread=GetCurrentThreadId();
    var attached=false;
    if(fgThread!=0&&fgThread!=thisThread)attached=AttachThreadInput(thisThread,fgThread,true);
    SwitchToThisWindow(found,true);
    BringWindowToTop(found);
    fg=SetForegroundWindow(found);
    if(attached)AttachThreadInput(thisThread,fgThread,false);
    System.Threading.Thread.Sleep(350);
    isFg=(GetForegroundWindow()==found);
    if(isFg)break;
    System.Threading.Thread.Sleep(900);
  }
  visible=IsWindowVisible(found);minimized=IsIconic(found);zrank=ZRank(found);
  // If the foreground switch still did not take, flash the taskbar entry so the user notices anyway.
  var flashed=false;
  if(!isFg){
    var fi=new FlashInfo();fi.cbSize=(uint)Marshal.SizeOf(fi);fi.hwnd=found;fi.flags=0x3|0xC;fi.count=6;fi.timeout=0;
    flashed=FlashWindowEx(ref fi);
  }
  var verdict=visible&&!minimized;
  return "{\"ok\":"+(verdict?"true":"false")+",\"ownerPid\":"+p.pid+",\"hwnd\":\"0x"+found.ToInt64().ToString("X")+"\",\"title\":\""+
    title.Replace("\\","\\\\").Replace("\"","\\\"")+"\",\"rect\":\""+fr.L+","+fr.T+","+fr.R+","+fr.B+
    "\",\"foreground\":"+(isFg?"true":"false")+",\"raised\":"+(fg?"true":"false")+",\"flashed\":"+(flashed?"true":"false")+",\"zrank\":"+zrank+",\"minimized\":"+(minimized?"true":"false")+"}";
 }
}
'@
  $result=[OrchestratorInactiveShell]::Launch([string]$request.file,[string]$request.parameters,[string]$request.cwd,[bool]$Activate.IsPresent)
  [Console]::Out.WriteLine($result)
  if($result -like '*"ok":false*'){exit 3}
} catch {
  [Console]::Error.WriteLine('INACTIVE_WINDOW_LAUNCH_FAILED: '+$_.Exception.Message)
  exit 1
}
