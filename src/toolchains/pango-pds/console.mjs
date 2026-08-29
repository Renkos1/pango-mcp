// Drive the Pango Fabric Debugger GUI's "Tcl Console" via UIAutomation.
//
// WHY: headless `cdt_dbg -file` cannot open the JTAG cable on this hardware
// (open_cable hangs — see docs/ILA-FINDINGS.md). The GUI
// debugger CAN open the cable, and it exposes a "Tcl Console" running the same
// tcl engine WITH THE CABLE ALREADY OPEN. So instead of fighting the headless
// path, we type tcl into that console and read its transcript back — fully
// AI-driven, no pixel-clicking, no user operation.
//
// HOW: the GUI lives in the interactive desktop session (session 1). An SSH
// command lands in the non-interactive service session (session 0), whose
// window station cannot reach session-1 windows. So we hop into session 1 via
// an INTERACTIVE scheduled task (`schtasks /ru <user> /it`) that runs a
// PowerShell+UIAutomation helper there. The helper finds the console's writable
// input Edit, `source {script.tcl}` into it (one line), polls the read-only
// transcript Edit for our done-marker, and writes the transcript delta to a
// file we read back over SSH.

const TASK_NAME = "fpga_ila_console";

// PowerShell helper that runs IN session 1. It locates the debugger console,
// records the transcript baseline, types `source {srcFwd}` into the input box,
// then waits for the tcl script to drop a SENTINEL FILE (reliable — a plain
// `puts` from a sourced script goes to process stdout, NOT the GUI transcript,
// so a transcript marker is not a dependable completion signal). On completion
// it writes: the sentinel body (RC/RES from the tcl catch) + the transcript
// delta (where dbg_* command output IS printed) to outPath.
function helperPs({ srcFwd, sentinelPath, outPath, timeoutMs }) {
  const out2 = outPath.replace(/\\/g, "\\\\");
  const sent2 = sentinelPath.replace(/\\/g, "\\\\");
  return `
$ErrorActionPreference='Stop'
function Finish($body){ [IO.File]::WriteAllText("${out2}", $body, [Text.Encoding]::UTF8); exit }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  $AE=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
  $VP=[System.Windows.Automation.ValuePattern]
  $pr=@(Get-Process cdt_dbg -ErrorAction SilentlyContinue)[0]
  if ($pr -eq $null) { Finish "MCP_NO_GUI: cdt_dbg (Fabric Debugger) is not running in session 1" }
  $cond=New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty,$pr.Id)
  $win=$AE::RootElement.FindFirst($TS::Children,$cond)
  if ($win -eq $null) { Finish "MCP_NO_WINDOW: no top-level window for cdt_dbg pid $($pr.Id)" }
  # Scope to the 'Console' dock window so we always find the Tcl Console input
  # Edit, even when other panels (Trigger Setup, etc.) add their own Edit fields.
  $winCond=New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
  $cnameCond=New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty,"Console")
  $consoleAnd=New-Object System.Windows.Automation.AndCondition(@($winCond,$cnameCond))
  $consoleWin=$win.FindFirst($TS::Descendants,$consoleAnd)
  $searchRoot=if($consoleWin -ne $null){ $consoleWin } else { $win }
  $editCond=New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
  $edits=$searchRoot.FindAll($TS::Descendants,$editCond)
  $input=$null; $transcript=$null; $tlen=-1
  foreach ($e in $edits) {
    $ro=$true; $vlen=0
    try { $vp=$e.GetCurrentPattern($VP::Pattern); $ro=$vp.Current.IsReadOnly; $vlen=([string]$vp.Current.Value).Length } catch { continue }
    if (-not $ro) { $input=$e }
    elseif ($vlen -gt $tlen) { $transcript=$e; $tlen=$vlen }
  }
  if ($input -eq $null) { Finish "MCP_NO_INPUT: no writable console input Edit (is the Tcl Console tab open?)" }
  if ($transcript -eq $null) { $transcript=$input }
  $base=([string]$transcript.GetCurrentPattern($VP::Pattern).Current.Value).Length
  if (Test-Path "${sent2}") { Remove-Item "${sent2}" -Force }
  $input.SetFocus(); Start-Sleep -Milliseconds 200
  $input.GetCurrentPattern($VP::Pattern).SetValue('source {${srcFwd}}'); Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $deadline=(Get-Date).AddMilliseconds(${timeoutMs})
  $sentinel=$false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    if (Test-Path "${sent2}") { $sentinel=$true; Start-Sleep -Milliseconds 200; break }
  }
  $full=[string]$transcript.GetCurrentPattern($VP::Pattern).Current.Value
  $delta=if ($full.Length -ge $base) { $full.Substring($base) } else { $full }
  $sbody=''
  if ($sentinel) { try { $sbody=[IO.File]::ReadAllText("${sent2}") } catch {} }
  $head=if ($sentinel) { "MCP_SENTINEL=1" } else { "MCP_SENTINEL=0 (timeout; command may still be running / JTAG slow)" }
  Finish ($head + "\`n" + $sbody + "---TRANSCRIPT---\`n" + $delta)
} catch {
  Finish ("MCP_FATAL: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
}
`;
}

// Run a tcl snippet in the GUI debugger console on a remote host. Returns the
// transcript delta (everything the console printed for this submission).
//   executor : an SshExecutor (remote GUI host). Local is rejected.
//   tcl      : tcl source to run (may be multiple statements).
//   user     : the interactive desktop user the GUI runs as (e.g. Administrator).
export async function driveConsole(executor, { tcl, user = "Administrator", timeoutSec = 60 } = {}) {
  if (!executor || typeof executor.runGuiHelper !== "function") throw new Error("executor 不支持 GUI 会话驱动（缺 runGuiHelper）");
  // Build the session-1 helper + its tcl input once the work dir is known; WHERE
  // it runs (local-direct vs SSH+schtasks) is the executor's concern.
  const build = (work, sep) => {
    const srcPath = `${work}${sep}script.tcl`;
    const sentinelPath = `${work}${sep}done.flag`;
    const outPath = `${work}${sep}out.txt`;
    const srcFwd = srcPath.replace(/\\/g, "/");
    const sentinelFwd = sentinelPath.replace(/\\/g, "/");
    // Run user tcl under catch, then drop a sentinel FILE with the catch rc/result
    // (tcl file I/O is the reliable completion signal — see helperPs note).
    const scriptTcl = `set __rc [catch {\n${tcl}\n} __res]\nset __f [open {${sentinelFwd}} w]\nputs $__f "RC=$__rc"\nputs $__f "RES=$__res"\nclose $__f\n`;
    const helper = helperPs({ srcFwd, sentinelPath, outPath, timeoutMs: timeoutSec * 1000 });
    return { helperPs: helper, files: [{ name: "script.tcl", content: scriptTcl }], outName: "out.txt" };
  };
  const r = await executor.runGuiHelper(build, { timeoutSec, taskName: TASK_NAME, user });
  const body = r.out || r.raw || "";
  // out.txt layout: "MCP_SENTINEL=<0|1>\nRC=<n>\nRES=<...>\n---TRANSCRIPT---\n<delta>"
  const completed = /MCP_SENTINEL=1/.test(body);
  const rc = /(?:^|\n)RC=(\d+)/.exec(body)?.[1];
  const tc0 = body.indexOf("---TRANSCRIPT---");
  const delta = tc0 >= 0 ? body.slice(tc0 + "---TRANSCRIPT---".length).replace(/^\r?\n/, "") : "";
  const res = /(?:^|\n)RES=([\s\S]*?)\r?\n---TRANSCRIPT---/.exec(body)?.[1] ?? "";
  const fatal = /MCP_FATAL|MCP_NO_GUI|MCP_NO_WINDOW|MCP_NO_INPUT|MCP_NO_OUT/.test(body);
  return {
    ok: completed && rc === "0" && !fatal,
    completed,
    rc: rc != null ? Number(rc) : null,
    tclResult: res,
    delta,
    raw: r.raw,
    work: r.work,
  };
}

// Convenience: read the on-chip ADC register at `address` (e.g. die temperature)
// through the console, returning the raw transcript and any parsed hex/dec value.
export async function consoleAdcRead(executor, { address, user, timeoutSec = 40 } = {}) {
  const addr = typeof address === "number" ? `0x${address.toString(16)}` : String(address);
  const r = await driveConsole(executor, { user, timeoutSec, tcl: `dbg_adc_read_reg -address ${addr}` });
  return { ...r, address: addr, value: parseAdcValue(r.delta) };
}

// Pull a value like "...: 0x1a2b" or "value = 6699" out of the console transcript.
function parseAdcValue(text) {
  if (!text) return null;
  const hex = /0x[0-9a-fA-F]+/.exec(text);
  if (hex) return { hex: hex[0], dec: parseInt(hex[0], 16) };
  const dec = /\b(\d{1,10})\b/.exec(text.replace(/takes\s+[\d.]+\s+seconds/gi, ""));
  return dec ? { dec: Number(dec[1]) } : null;
}
