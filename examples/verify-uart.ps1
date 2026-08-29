param([string]$Port = "COM5", [int]$Baud = 115200, [int]$N = 16, [int]$Heartbeat = 0x5A)
# Closed-loop UART check for the UART bring-up design (RX=V14, TX=U14, echo + idle
# heartbeat). FPGA TX -> serial module -> COM5 (we READ); COM5 -> module -> FPGA
# RX (we WRITE). Heartbeat 0x5A is filtered so it can't masquerade as an echo.
$sp = New-Object System.IO.Ports.SerialPort $Port,$Baud,'None',8,'One'
$sp.ReadTimeout = 800; $sp.WriteTimeout = 800
$sp.Open()
try {
  Start-Sleep -Milliseconds 200
  $sp.DiscardInBuffer()
  # (1) TX isolation: collect bytes for ~1.2 s; expect heartbeat 0x5A.
  $hb = @(); $deadline = (Get-Date).AddMilliseconds(1200)
  while ((Get-Date) -lt $deadline) { try { $hb += $sp.ReadByte() } catch {} }
  $hbHex = ($hb | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
  $sawHb = ($hb -contains $Heartbeat)
  Write-Output ("TX heartbeat bytes (" + $hb.Count + "): " + $hbHex)
  Write-Output ("TX check (saw 0x{0:X2}): {1}" -f $Heartbeat, $(if ($sawHb) {'PASS'} else {'FAIL'}))
  # (2) RX/echo: send N random bytes (excluding heartbeat); read back, skipping
  # any heartbeat bytes; compare.
  $sp.DiscardInBuffer()
  $rng = [Random]::new(); $fail = 0
  for ($i = 0; $i -lt $N; $i++) {
    do { $b = $rng.Next(0,256) } while ($b -eq $Heartbeat)
    $sp.Write([byte[]]@($b),0,1)
    $got = -1
    for ($t = 0; $t -lt 4; $t++) { try { $g = $sp.ReadByte() } catch { break }; if ($g -ne $Heartbeat) { $got = $g; break } }
    if ($got -ne $b) { Write-Output ("  MISMATCH sent {0:X2} got {1:X2}" -f $b, $got); $fail++ }
  }
  Write-Output ("RX echo check: " + $(if ($fail -eq 0) {"PASS ($N/$N)"} else {"FAIL ($fail/$N)"}))
  if ($sawHb -and $fail -eq 0) { Write-Output "OVERALL PASS"; exit 0 } else { Write-Output "OVERALL FAIL"; exit 1 }
} finally { $sp.Close() }
