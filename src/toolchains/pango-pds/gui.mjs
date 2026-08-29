// Session-1 GUI automation primitives for the Pango Fabric Debugger.
//
// An SSH command lands in session 0 (non-interactive service session) whose
// window station cannot see or drive the GUI that lives on the interactive
// desktop (session 1). `runInSession1` hops into session 1 via an interactive
// scheduled task (`schtasks /ru <user> /it`) and runs an arbitrary PowerShell
// body there, returning whatever the body writes to $OUT. Everything else here
// (launch the debugger, find/click a button, drive the Tcl Console) is built on
// top of that one primitive — fully AI-driven, no manual clicks.

// Run a PowerShell body IN the interactive GUI session. The body writes its
// result to the $OUT path (provided for it). Returns { ok, out, raw }. WHERE this
// runs is the executor's concern — see Executor.runGuiHelper; this stays blind to
// transport. BOTH local and remote reach the GUI's session via the same
// interactive, highest-integrity scheduled-task hop (an elevated GUI blocks
// SendKeys/Invoke from a lower-integrity or other-session helper), so a local
// board's GUI works the same as a remote one.
export async function runInSession1(executor, { ps, user = "Administrator", timeoutSec = 60, taskName } = {}) {
  if (!executor || typeof executor.runGuiHelper !== "function") throw new Error("executor 不支持 GUI 会话驱动（缺 runGuiHelper）");
  const build = (work, sep) => {
    const out2 = `${work}${sep}out.txt`.replace(/\\/g, "\\\\");
    // $OUT is provided; body writes to it. Wrap in try/catch so failures surface.
    const full = `$ErrorActionPreference='Stop'
$OUT="${out2}"
if (Test-Path $OUT) { Remove-Item $OUT -Force }
function Emit($s){ [IO.File]::WriteAllText($OUT, [string]$s, [Text.Encoding]::UTF8) }
try {
${ps}
} catch { Emit ("S1_FATAL: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message) }
`;
    return { helperPs: full, outName: "out.txt" };
  };
  const r = await executor.runGuiHelper(build, { timeoutSec, taskName, user });
  const out = r.out ?? "";
  return { ok: out !== "" && !/S1_FATAL|S1_NO_OUT/.test(out), out, raw: r.raw };
}

// Shared UIAutomation prelude: loads assemblies and defines $AE/$TS/$VP and a
// Find-DbgWindow function returning the top-level cdt_dbg window (or $null).
export const UIA_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$AE=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$VP=[System.Windows.Automation.ValuePattern]; $IP=[System.Windows.Automation.InvokePattern]
function Find-DbgWindow {
  $pr=@(Get-Process cdt_dbg -ErrorAction SilentlyContinue)[0]
  if ($pr -eq $null) { return $null }
  $cond=New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty,$pr.Id)
  return $AE::RootElement.FindFirst($TS::Children,$cond)
}
`;

// Launch the Fabric Debugger GUI on a project directory, in session 1, and wait
// until its top-level window appears. cdt_dbg in GUI mode (no -file) opens the
// cable; headless -file cannot (see docs/ILA-FINDINGS.md).
export async function launchDebugger(executor, { binDir, projectDir, user = "Administrator", waitSec = 25 } = {}) {
  const exe = `${binDir}\\cdt_dbg.exe`;
  const ps = `${UIA_PRELUDE}
$existing = Find-DbgWindow
if ($existing -ne $null) { Emit ("ALREADY_RUNNING: " + $existing.Current.Name); return }
Start-Process -FilePath "${exe}" -ArgumentList @("${projectDir.replace(/\\/g, "\\\\")}") -WorkingDirectory "${binDir.replace(/\\/g, "\\\\")}"
$deadline=(Get-Date).AddSeconds(${waitSec})
$win=$null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $win = Find-DbgWindow
  if ($win -ne $null -and $win.Current.Name.Length -gt 0) { break }
}
if ($win -eq $null) { Emit "LAUNCH_NO_WINDOW: cdt_dbg did not produce a window"; return }
Emit ("LAUNCHED: " + $win.Current.Name)
`;
  return runInSession1(executor, { ps, user, timeoutSec: waitSec + 20 });
}

// Invoke a named Button in the debugger window (e.g. "Search JTAG Chain",
// "Connect to Server") via UIAutomation InvokePattern — the GUI scan path opens
// the cable cleanly, where the console `dbg_scan_chain` (open_cable) deadlocks.
export async function invokeButton(executor, { name, user = "Administrator", settleSec = 3, timeoutSec = 40 } = {}) {
  const ps = `${UIA_PRELUDE}
$win = Find-DbgWindow
if ($win -eq $null) { Emit "NO_DBG_WINDOW"; return }
$btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
$nameCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty,"${name}")
$and = New-Object System.Windows.Automation.AndCondition(@($btnCond,$nameCond))
$btn = $win.FindFirst($TS::Descendants,$and)
if ($btn -eq $null) { Emit "NO_BUTTON: ${name}"; return }
try { $btn.GetCurrentPattern($IP::Pattern).Invoke() } catch { Emit ("INVOKE_FAIL: " + $_.Exception.Message); return }
Start-Sleep -Seconds ${settleSec}
# Report any modal dialog that popped up (e.g. cable picker) so the caller can react.
$dlgs = $win.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)))
$names = @(); foreach($d in $dlgs){ $names += $d.Current.Name }
Emit ("INVOKED: ${name} | child-windows: " + ($names -join ' | '))
`;
  return runInSession1(executor, { ps, user, timeoutSec });
}

// Bring a named child dialog to the foreground (by native handle) and send it
// keystrokes — for native/Qt modals (Open Cable, file pickers) that expose no
// UIA-clickable controls. Reports the sub-windows still open afterward.
export async function sendKeysToDialog(executor, { name, keys = "{ENTER}", user = "Administrator", settleSec = 4, timeoutSec = 40 } = {}) {
  const ps = `${UIA_PRELUDE}
Add-Type @"
using System; using System.Runtime.InteropServices;
public class U32 { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }
"@
$pr=@(Get-Process cdt_dbg -ErrorAction SilentlyContinue)[0]
if($pr-eq$null){ Emit "NO_GUI"; return }
$pcond=New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty,$pr.Id)
$ncond=New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty,"${name}")
$and=New-Object System.Windows.Automation.AndCondition(@($pcond,$ncond))
$deadline=(Get-Date).AddSeconds(12); $dlg=$null
while((Get-Date) -lt $deadline -and $dlg -eq $null){ $dlg=$AE::RootElement.FindFirst($TS::Descendants,$and); if($dlg-eq$null){Start-Sleep -Milliseconds 400} }
if($dlg-eq$null){ Emit "NO_DIALOG: ${name}"; return }
$h=[IntPtr]$dlg.Current.NativeWindowHandle
[U32]::ShowWindow($h,5)|Out-Null; [U32]::SetForegroundWindow($h)|Out-Null; Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("${keys}")
Start-Sleep -Seconds ${settleSec}
$pr2=@(Get-Process cdt_dbg -ErrorAction SilentlyContinue)[0]
$wins=$AE::RootElement.FindAll($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty,$pr2.Id)))
$names=@(); foreach($w in $wins){ $sub=$w.FindAll($TS::Children,(New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window))); foreach($s in $sub){$names+=$s.Current.Name} }
Emit ("SENT ${keys} to '${name}' | sub-windows: " + ($names -join ' | '))
`;
  return runInSession1(executor, { ps, user, timeoutSec });
}

// Orchestrate the GUI scan: click "Search JTAG Chain" (whose Invoke blocks on the
// modal 'Open Cable' dialog) without awaiting, then accept that dialog with ENTER.
// This is the GUI path that opens the cable cleanly (console open_cable hangs).
export async function searchJtagAndOpenCable(executor, { user = "Administrator" } = {}) {
  const clickP = invokeButton(executor, { name: "Search JTAG Chain", user, settleSec: 1, timeoutSec: 25 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3500));
  const dlg = await sendKeysToDialog(executor, { name: "Open Cable", keys: "{ENTER}", user, settleSec: 4 });
  await clickP;
  return dlg;
}

// Dump the cdt_dbg UIA tree (control type / automationId / name) so we can find
// buttons (scan/connect) and the console input. depth-bounded.
export async function dumpDbgTree(executor, { user = "Administrator", maxDepth = 8, timeoutSec = 40 } = {}) {
  const ps = `${UIA_PRELUDE}
$win = Find-DbgWindow
if ($win -eq $null) { Emit "NO_DBG_WINDOW"; return }
$sb = New-Object System.Text.StringBuilder
function Walk($el,$d){
  if ($el -eq $null -or $d -gt ${maxDepth}) { return }
  try { $ct=$el.Current.ControlType.ProgrammaticName; $nm=[string]$el.Current.Name; if($nm.Length-gt50){$nm=$nm.Substring(0,50)}; $aid=[string]$el.Current.AutomationId } catch { return }
  [void]$sb.AppendLine(('  '*$d)+"[$ct] id='$aid' name='$nm'")
  try { $kids=$el.FindAll($TS::Children,[System.Windows.Automation.Condition]::TrueCondition) } catch { return }
  foreach($k in $kids){ Walk $k ($d+1) }
}
Walk $win 0
Emit $sb.ToString()
`;
  return runInSession1(executor, { ps, user, timeoutSec });
}
