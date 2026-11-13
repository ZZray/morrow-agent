# Copyright (c) Ray Zhang. Isolated visible test surface; never targets user apps.
param([string]$StatePath, [string]$StopPath, [string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FixtureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
[void][FixtureDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = [Windows.Forms.Form]::new()
$form.Text = $Title
$form.Size = [Drawing.Size]::new(620,300)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI',12)
$inputBox = [Windows.Forms.TextBox]::new()
$inputBox.AccessibleName = 'Reach Test Input'
$inputBox.Location = [Drawing.Point]::new(24,32)
$inputBox.Size = [Drawing.Size]::new(550,40)
$button = [Windows.Forms.Button]::new()
$button.Text = 'Reach Test Commit'
$button.AccessibleName = 'Reach Test Commit'
$button.Location = [Drawing.Point]::new(24,94)
$button.Size = [Drawing.Size]::new(250,46)
$label = [Windows.Forms.Label]::new()
$label.Location = [Drawing.Point]::new(24,165)
$label.Size = [Drawing.Size]::new(550,60)
$label.Text = 'Waiting for Reach desktop test'
$script:clicks = 0
$script:committed = ''
$button.Add_Click({ $script:clicks++; $script:committed=$inputBox.Text; $label.Text="Committed $script:clicks : $script:committed" })
$form.Controls.AddRange(@($inputBox,$button,$label))
$start = [DateTime]::UtcNow
$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
    if ((Test-Path -LiteralPath $StopPath) -or ([DateTime]::UtcNow-$start).TotalMinutes -gt 10) { $form.Close(); return }
    $bounds=$form.Bounds
    $state = @{ pid=$PID; title=$form.Text; text=$inputBox.Text; committed=$script:committed; clicks=$script:clicks; region=@($bounds.Left,$bounds.Top,$bounds.Right,$bounds.Bottom) }
    [IO.File]::WriteAllText($StatePath,($state | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
})
$form.Add_Shown({ [void][FixtureDpi]::ShowWindow($form.Handle,5); [void][FixtureDpi]::SetForegroundWindow($form.Handle); $form.Activate(); $timer.Start() })
try { [Windows.Forms.Application]::Run($form) } finally { $timer.Dispose(); $form.Dispose() }
