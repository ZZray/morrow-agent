# Copyright (c) Ray Zhang. Pixel-only challenge; answers are never in UIA text.
param([string]$DefinitionPath,[string]$StatePath,[string]$StopPath)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VisionDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
[void][VisionDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$definition=Get-Content -LiteralPath $DefinitionPath -Raw|ConvertFrom-Json
$form=[Windows.Forms.Form]::new()
$form.Text='Reach vision verification'
$form.ClientSize=[Drawing.Size]::new(640,320)
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$form.BackColor=[Drawing.Color]::White
$font=[Drawing.Font]::new('Consolas',28,[Drawing.FontStyle]::Bold)
$form.Add_Paint({
 param($sender,$event)
 $g=$event.Graphics
 $g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
 $g.DrawString($definition.code,$font,[Drawing.Brushes]::Black,[Drawing.PointF]::new(32,24))
 for($index=0;$index -lt $definition.items.Count;$index++) {
  $item=$definition.items[$index]
  $brush=[Drawing.SolidBrush]::new([Drawing.Color]::FromName($item.color))
  $x=40+200*$index
  try {
   switch($item.shape) {
    'square' {$g.FillRectangle($brush,$x,128,120,120)}
    'circle' {$g.FillEllipse($brush,$x,128,120,120)}
    'triangle' {$points=[Drawing.Point[]]@([Drawing.Point]::new($x+60,128),[Drawing.Point]::new($x+120,248),[Drawing.Point]::new($x,248));$g.FillPolygon($brush,$points)}
   }
  } finally {$brush.Dispose()}
 }
})
$timer=[Windows.Forms.Timer]::new();$timer.Interval=100
$started=[DateTime]::UtcNow
$timer.Add_Tick({
 try {
 if((Test-Path -LiteralPath $StopPath) -or ([DateTime]::UtcNow-$started).TotalMinutes -gt 6){$form.Close();return}
 $b=$form.Bounds
 $origin=$form.PointToScreen([Drawing.Point]::new(0,0))
 [IO.File]::WriteAllText($StatePath,(@{pid=$PID;region=@($b.Left,$b.Top,$b.Right,$b.Bottom);clientOffset=@(($origin.X-$b.Left),($origin.Y-$b.Top));visible=$form.Visible;foreground=([VisionDpi]::GetForegroundWindow() -eq $form.Handle)}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 } catch { [IO.File]::WriteAllText($StatePath+'.error',$_.ToString());$form.Close() }
})
$form.Add_Shown({[void][VisionDpi]::ShowWindow($form.Handle,5);[void][VisionDpi]::SetForegroundWindow($form.Handle);$form.Activate();$timer.Start()})
try {[Windows.Forms.Application]::Run($form)} finally {$timer.Dispose();$font.Dispose();$form.Dispose()}
