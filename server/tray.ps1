# Hidden Windows tray host. The Node process supplies the embedded icon and app URL;
# writing CLOSE to stdout asks that process to perform its normal shutdown sequence.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$tray = New-Object System.Windows.Forms.NotifyIcon
# Keep the icon stream alive for the lifetime of the NotifyIcon.
$iconBytes = [Convert]::FromBase64String($env:SNIPER_HUNTER_TRAY_ICON_B64)
$iconStream = [System.IO.MemoryStream]::new($iconBytes)
$trayIcon = [System.Drawing.Icon]::new($iconStream)
$tray.Icon = $trayIcon
$tray.Text = 'Sniper Hunter'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$show = $menu.Items.Add('Show')
$close = $menu.Items.Add('Close')
$openPage = { Start-Process $env:SNIPER_HUNTER_TRAY_URL }
$show.add_Click($openPage)
$tray.add_DoubleClick($openPage)
$close.add_Click({
  [Console]::Out.WriteLine('CLOSE')
  [Console]::Out.Flush()
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $tray.Visible = $false
  $tray.Dispose()
  $trayIcon.Dispose()
  $iconStream.Dispose()
  $menu.Dispose()
}
