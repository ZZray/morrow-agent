# Copyright (c) Ray Zhang. Pass actual standard pipe handles to the test descendant.
param([string]$EncodedCommand,[string]$PidPath,[string]$StartedPath)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class ReachDrainChild {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public uint cb; public IntPtr reserved,desktop,title;
  public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
  public ushort show,reserved2; public IntPtr bytes,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,System.Text.StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out Info info);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static uint Start(string exe,string encoded) {
  var startup=new Startup();startup.cb=(uint)Marshal.SizeOf(typeof(Startup));startup.flags=0x100;
  startup.input=GetStdHandle(-10);startup.output=GetStdHandle(-11);startup.error=GetStdHandle(-12);
  foreach(var handle in new[]{startup.input,startup.output,startup.error})
   if(!SetHandleInformation(handle,1,1))throw new Win32Exception(Marshal.GetLastWin32Error());
  Info info;
  if(!CreateProcess(exe,new System.Text.StringBuilder("\""+exe+"\" -NoProfile -NonInteractive -EncodedCommand "+encoded),IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,null,ref startup,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
  CloseHandle(info.thread);CloseHandle(info.process);return info.pid;
 }
}
'@
$childId=[ReachDrainChild]::Start((Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'),$EncodedCommand)
[IO.File]::WriteAllText($PidPath,[string]$childId)
$deadline=[DateTime]::UtcNow.AddSeconds(10)
while(-not [IO.File]::Exists($StartedPath)){
    if([DateTime]::UtcNow-ge$deadline){throw 'Descendant did not flush its start frame'}
    Start-Sleep -Milliseconds 20
}
[Console]::Out.WriteLine('parent-exiting')
[Console]::Out.Flush()
