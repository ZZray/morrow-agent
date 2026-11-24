# Copyright (c) Ray Zhang. Configure the already installed Reach service.
param(
    [string]$ReachCli = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RY/Reach/bin/ryreach.exe')
)

$ErrorActionPreference = 'Stop'
$configText = & $ReachCli config show
if ($LASTEXITCODE -ne 0) { throw '无法读取 Reach 服务配置。' }
$config = $configText | ConvertFrom-Json
if ($null -eq $config.PSObject.Properties['serverUrl']) { throw 'Reach 服务配置缺少地址字段。' }
if ($config.serverUrl) { return }

Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$timer = [Windows.Forms.Timer]::new()
$operation = @{ Process = $null; Output = $null; Error = $null }
try {
    $form.Text = 'Reach · 设置服务端地址'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MinimizeBox = $false
    $form.MaximizeBox = $false
    $form.AutoScaleMode = 'Font'
    $form.Font = [Drawing.SystemFonts]::MessageBoxFont
    $form.AutoSize = $true
    $form.AutoSizeMode = 'GrowAndShrink'

    $layout = [Windows.Forms.TableLayoutPanel]::new()
    $layout.ColumnCount = 1
    $layout.AutoSize = $true
    $layout.AutoSizeMode = 'GrowAndShrink'
    $layout.Dock = 'Fill'
    $layout.Padding = [Windows.Forms.Padding]::new(16)
    $form.Controls.Add($layout)

    $heading = [Windows.Forms.Label]::new()
    $heading.AutoSize = $true
    $heading.Text = 'Reach 已安装。请输入服务端的 HTTPS 地址。'
    $layout.Controls.Add($heading)

    $address = [Windows.Forms.TextBox]::new()
    $address.AccessibleName = '服务端地址'
    $address.Width = 390
    $address.MaxLength = 512
    $address.Margin = [Windows.Forms.Padding]::new(3,8,3,5)
    $layout.Controls.Add($address)

    $status = [Windows.Forms.Label]::new()
    $status.AutoSize = $true
    $status.MaximumSize = [Drawing.Size]::new(390,0)
    $status.Text = '稍后也可以用 ryreach 命令设置或修改。'
    $layout.Controls.Add($status)

    $buttons = [Windows.Forms.FlowLayoutPanel]::new()
    $buttons.FlowDirection = 'RightToLeft'
    $buttons.WrapContents = $false
    $buttons.Dock = 'Fill'
    $buttons.AutoSize = $true
    $buttons.Margin = [Windows.Forms.Padding]::new(0,12,0,0)
    $layout.Controls.Add($buttons)

    $save = [Windows.Forms.Button]::new()
    $save.Text = '保存'
    $save.AutoSize = $true
    $save.Enabled = $false
    $buttons.Controls.Add($save)
    $later = [Windows.Forms.Button]::new()
    $later.Text = '稍后'
    $later.AutoSize = $true
    $later.DialogResult = 'Cancel'
    $buttons.Controls.Add($later)
    $form.AcceptButton = $save
    $form.CancelButton = $later
    $form.Add_Shown({ [void]$address.Focus() })
    $address.Add_TextChanged({ $save.Enabled = -not [string]::IsNullOrWhiteSpace($address.Text) })
    $form.Add_FormClosing({ if ($operation.Process) { $_.Cancel = $true } })

    $timer.Interval = 125
    $timer.Add_Tick({
        $process = $operation.Process
        if (!$process.HasExited -or !$operation.Output.IsCompleted -or !$operation.Error.IsCompleted) { return }
        $timer.Stop()
        try {
            $details = $operation.Error.GetAwaiter().GetResult()
            $exitCode = $process.ExitCode
        } finally {
            $process.Dispose()
            $operation.Process = $null
            $address.Enabled = $true
            $later.Enabled = $true
            $save.Enabled = $true
        }
        if ($exitCode -eq 0) {
            $form.DialogResult = 'OK'
            $form.Close()
        } elseif ($details -cmatch 'server URL saved \(') {
            $status.Text = '地址已保存，但尚未连通。请检查地址和证书后重试。'
        } else {
            $status.Text = '暂未确认连接。请检查服务端地址后重试，也可稍后用 ryreach 设置。'
        }
    })

    $save.Add_Click({
        $entered = $address.Text.Trim()
        $uri = $null
        # Keep exactly one native argument. Reach still validates the endpoint and authorizes the change.
        if ($entered -match '[\s"\p{Cc}]' -or -not [Uri]::TryCreate($entered,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https') {
            $status.Text = '请输入完整的 HTTPS 地址。'
            [void]$address.Focus()
            return
        }

        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ReachCli
        $start.Arguments = 'config set server-url ' + $entered
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = [Text.Encoding]::UTF8
        $start.StandardErrorEncoding = [Text.Encoding]::UTF8
        try {
            $operation.Process = [Diagnostics.Process]::Start($start)
            $operation.Output = $operation.Process.StandardOutput.ReadToEndAsync()
            $operation.Error = $operation.Process.StandardError.ReadToEndAsync()
            $address.Enabled = $false
            $save.Enabled = $false
            $later.Enabled = $false
            $status.Text = '正在连接服务端…'
            $timer.Start()
        } catch {
            if ($operation.Process) { $operation.Process.Dispose(); $operation.Process = $null }
            $status.Text = '无法启动配置命令。请稍后运行 ryreach。'
        }
    })
    [void]$form.ShowDialog()
} finally {
    $timer.Dispose()
    $form.Dispose()
}
