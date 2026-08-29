// Execution-device layer: the "解离点" between WHAT a toolchain does (command
// construction, log parsing, guards) and WHERE it runs. Every toolchain that
// touches a process/filesystem should go through an Executor so the same logic
// can run locally (default) or on a remote device over SSH.
//
// LocalExecutor = current behavior (spawn/which/exists on this machine).
// SshExecutor   = run/which/exists on a remote host via ssh2 (e.g. move JTAG
//                 scan/flash off this box). File staging (push sources / pull
//                 artifacts) for remote builds is a later increment; this first
//                 slice covers the read-only probe surface (run/which/exists)
//                 needed by a remote fpga_env.
//
// Interface (all async, so Local and Ssh are interchangeable):
//   run(file, args, { cwd, timeoutSec, env }) -> { code, stdout, stderr, timedOut }
//   which(cmd)    -> absolute path string | null
//   exists(path)  -> boolean
//   close()       -> release any connection (no-op for local)

import pkg from "ssh2";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG, toolEnv } from "./config.mjs";
import { run as localRun, which as localWhich } from "./exec.mjs";

const { Client } = pkg;

let guiSeq = 0;

// Extract the helper's out-file body from a session-1 driver transcript (the SSH
// driver wraps it in OUT_BEGIN/OUT_END). out is "" when the helper produced
// nothing (driver printed S1_NO_OUT instead of a wrapper).
function parseGuiDriverOut(stdout) {
  const m = /===OUT_BEGIN===\r?\n([\s\S]*?)\r?\n===OUT_END===/.exec(stdout || "");
  return m ? { out: m[1], raw: undefined } : { out: "", raw: stdout };
}

// Walk a local dir, yielding { abs, rel } for every file (rel uses forward slashes).
function walkLocal(root) {
  const out = [];
  (function rec(dir, rel) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) rec(abs, r);
      else out.push({ abs, rel: r });
    }
  })(root, "");
  return out;
}

export const LocalExecutor = {
  id: "local",
  label: "本机",
  os: process.platform === "win32" ? "windows" : "posix",
  isRemote: false,
  async run(file, args, opts = {}) {
    return localRun(file, args, opts);
  },
  async which(cmd) {
    return localWhich(cmd);
  },
  async exists(path) {
    return !!path && existsSync(path);
  },
  async mkdtemp(prefix = "fpga-") {
    return mkdtempSync(join(tmpdir(), prefix));
  },
  // Staging is a no-op locally: the toolchain already works in place.
  async putDir() {},
  async getDir() {},
  async putFile() {},
  async getFile(remote, local) {
    if (resolve(remote) !== resolve(local)) copyFileSync(remote, local);
  },
  // Run a PowerShell helper INSIDE the interactive GUI desktop session and return
  // what it writes to <work>\<outName>. We used to spawn the helper directly,
  // assuming the MCP already sits in the GUI's session at matching integrity. That
  // breaks when the GUI runs elevated in a different / RDP session (e.g. an
  // Administrator console): UIAutomation can READ the elevated window, but
  // SendKeys / InvokePattern INTO it are blocked by UIPI ("access denied"), so the
  // cable-open {ENTER} and the console `source` never land — it looks hung. Fix:
  // run the helper through an INTERACTIVE, HIGHEST-integrity scheduled task
  // (schtasks /it /rl HIGHEST /ru <user>) so it lands in the GUI's session AT the
  // GUI's integrity — the same session hop the remote path relies on, plus
  // /rl HIGHEST to clear UIPI against an elevated GUI. `user` defaults to
  // Administrator (the interactive desktop user on our boards); pass it through for
  // other setups. `build(work, sep)` returns the helper + any input files once the
  // work dir (and the absolute paths the helper must bake in) is known.
  async runGuiHelper(build, { timeoutSec = 60, taskName, user = "Administrator" } = {}) {
    const work = mkdtempSync(join(tmpdir(), "fpga-gui-"));
    const { helperPs, files = [], outName = "out.txt" } = build(work, "\\");
    for (const f of files) writeFileSync(join(work, f.name), f.content, "utf8");
    const helperPath = join(work, "helper.ps1");
    writeFileSync(helperPath, helperPs, "utf8");
    const outPath = join(work, outName);
    const tn = taskName || `fpga_gui_${process.pid}_${guiSeq++}`;
    // Driver: register + run the interactive task, poll for the helper's out file,
    // then delete the task. If out never appears, surface the schtasks create/run
    // output (e.g. an elevation/login error) instead of a silent empty result. The
    // helper polls up to ~timeoutSec for its sentinel, so every budget exceeds it.
    const driver = `
$ErrorActionPreference='SilentlyContinue'
schtasks /delete /tn ${tn} /f *> $null
$c = schtasks /create /tn ${tn} /tr "powershell -NoProfile -ExecutionPolicy Bypass -File ${helperPath}" /sc ONCE /st 23:59 /ru ${user} /rl HIGHEST /it /f 2>&1
$r = schtasks /run /tn ${tn} 2>&1
$deadline=(Get-Date).AddSeconds(${timeoutSec + 15})
while((Get-Date) -lt $deadline -and -not (Test-Path '${outPath}')){ Start-Sleep -Milliseconds 400 }
schtasks /delete /tn ${tn} /f *> $null
if (-not (Test-Path '${outPath}')) { Write-Output ("S1_NO_OUT create=[" + ($c -join ' ') + "] run=[" + ($r -join ' ') + "]") }
`;
    const driverPath = join(work, "driver.ps1");
    writeFileSync(driverPath, driver, "utf8");
    const res = await localRun("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driverPath], { timeoutSec: timeoutSec + 40 });
    const out = existsSync(outPath) ? readFileSync(outPath, "utf8") : (res.stdout || "S1_NO_OUT");
    try { rmSync(work, { recursive: true, force: true }); } catch {}
    return { out, work };
  },
  async close() {},
};

// Quote a token for a remote Windows `cmd /c` line. cmd quoting is fiddly; for
// the probe surface (where/if exist) we only pass simple tokens. Build/flash
// dispatch will harden this later.
function winQuote(s) {
  const str = String(s);
  return /[\s"&|<>^()]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
// Always-quote a Windows path token. A bare path (even without spaces) behaves
// inconsistently through the SSH→cmd /c wrapping; quoting is also required for
// "C:\Program Files\..." style paths. So path args are always double-quoted.
function winQuotePath(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class SshExecutor {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.label = `ssh:${cfg.user || ""}@${cfg.host}:${cfg.port || 22}`;
    this.os = cfg.os || "windows";
    this._conn = null;
    this._connecting = null;
  }

  async _connect() {
    if (this._conn) return this._conn;
    if (this._connecting) return this._connecting;
    const c = this.cfg;
    const connectCfg = {
      host: c.host,
      port: c.port || 22,
      username: c.user,
      readyTimeout: c.readyTimeoutMs || 15000,
      keepaliveInterval: 10000,
    };
    if (c.privateKeyPath) {
      connectCfg.privateKey = readFileSync(c.privateKeyPath);
      if (c.passphrase) connectCfg.passphrase = c.passphrase;
    } else if (c.password) {
      connectCfg.password = c.password;
    } else {
      throw new Error(`host '${this.id}' 缺少认证：配置 privateKeyPath 或 password（密码可走 PANGO_MCP_SSH_${this.id}_PASSWORD）`);
    }
    this._connecting = new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on("ready", () => resolve(conn));
      conn.on("error", (err) => reject(new Error(`SSH 连接 ${this.label} 失败: ${err.message}`)));
      conn.connect(connectCfg);
    }).then((conn) => {
      this._conn = conn;
      this._connecting = null;
      return conn;
    });
    return this._connecting;
  }

  // Run a raw command line through the remote default shell, capture output.
  async exec(commandLine, { timeoutSec = 30 } = {}) {
    const conn = await this._connect();
    return new Promise((resolve) => {
      conn.exec(commandLine, (err, stream) => {
        if (err) return resolve({ code: 1, stdout: "", stderr: String(err.message || err), timedOut: false });
        let stdout = "";
        let stderr = "";
        let done = false;
        const finish = (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(res);
        };
        const timer = setTimeout(() => {
          try {
            stream.close();
          } catch {}
          finish({ code: 124, stdout, stderr, timedOut: true });
        }, timeoutSec * 1000);
        stream.on("data", (d) => (stdout += d.toString()));
        stream.stderr.on("data", (d) => (stderr += d.toString()));
        stream.on("close", (code) => finish({ code: typeof code === "number" ? code : 0, stdout, stderr, timedOut: false }));
      });
    });
  }

  async run(file, args = [], opts = {}) {
    const cmdline =
      this.os === "windows"
        ? `cmd /c ${[winQuotePath(file), ...args.map(winQuote)].join(" ")}`
        : `${[file, ...args].map(shQuote).join(" ")}`;
    return this.exec(cmdline, opts);
  }

  async which(cmd) {
    const r = this.os === "windows" ? await this.exec(`cmd /c where ${winQuote(cmd)}`) : await this.exec(`command -v ${shQuote(cmd)}`);
    if (r.code !== 0) return null;
    const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  }

  async exists(path) {
    if (this.os === "windows") {
      const r = await this.exec(`cmd /c if exist ${winQuotePath(path)} (echo __YES__) else (echo __NO__)`);
      return /__YES__/.test(r.stdout);
    }
    const r = await this.exec(`test -e ${shQuote(path)} && echo __YES__ || echo __NO__`);
    return /__YES__/.test(r.stdout);
  }

  // ----- file staging (SFTP) — push sources / pull build artifacts -----
  get isRemote() {
    return true;
  }

  async _sftp() {
    if (this._sftpConn) return this._sftpConn;
    const conn = await this._connect();
    this._sftpConn = await new Promise((resolve, reject) => conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
    return this._sftpConn;
  }

  // Native remote path (backslashes on Windows) -> SFTP path (forward slashes).
  toSftp(p) {
    return String(p).replace(/\\/g, "/");
  }

  async _remoteTemp() {
    if (this._tmpBase) return this._tmpBase;
    if (this.os === "windows") {
      const r = await this.exec("cmd /c echo %TEMP%");
      this._tmpBase = (r.stdout.trim() || "C:\\Windows\\Temp").replace(/"+$/, "");
    } else {
      const r = await this.exec('printf %s "${TMPDIR:-/tmp}"');
      this._tmpBase = r.stdout.trim() || "/tmp";
    }
    return this._tmpBase;
  }

  async mkdtemp(prefix = "fpga-") {
    const base = await this._remoteTemp();
    const name = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = this.os === "windows" ? `${base}\\${name}` : `${base}/${name}`;
    await this.mkdirp(dir);
    return dir;
  }

  async mkdirp(dir) {
    // cmd's mkdir creates intermediate dirs; -p on posix.
    if (this.os === "windows") await this.exec(`cmd /c if not exist ${winQuotePath(dir)} mkdir ${winQuotePath(dir)}`);
    else await this.exec(`mkdir -p ${shQuote(dir)}`);
  }

  async _put(localAbs, remoteNative) {
    const sftp = await this._sftp();
    await new Promise((resolve, reject) => sftp.fastPut(localAbs, this.toSftp(remoteNative), (err) => (err ? reject(err) : resolve())));
  }

  async _get(remoteNative, localAbs) {
    const sftp = await this._sftp();
    await new Promise((resolve, reject) => sftp.fastGet(this.toSftp(remoteNative), localAbs, (err) => (err ? reject(err) : resolve())));
  }

  async _readdir(remoteNative) {
    const sftp = await this._sftp();
    return new Promise((resolve, reject) => sftp.readdir(this.toSftp(remoteNative), (err, list) => (err ? reject(err) : resolve(list || []))));
  }

  // Recursively upload a local directory tree into remoteDir (native path).
  async putDir(localDir, remoteDir) {
    const sep = this.os === "windows" ? "\\" : "/";
    const files = walkLocal(localDir);
    const dirs = new Set();
    for (const f of files) {
      const parent = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
      if (parent) dirs.add(parent);
    }
    await this.mkdirp(remoteDir);
    for (const d of [...dirs].sort()) await this.mkdirp(`${remoteDir}${sep}${d.replace(/\//g, sep)}`);
    for (const f of files) await this._put(f.abs, `${remoteDir}${sep}${f.rel.replace(/\//g, sep)}`);
    return files.length;
  }

  // Recursively download remoteDir (native path) into localDir.
  async getDir(remoteDir, localDir) {
    const sep = this.os === "windows" ? "\\" : "/";
    let count = 0;
    const rec = async (rNative, lAbs) => {
      mkdirSync(lAbs, { recursive: true });
      for (const ent of await this._readdir(rNative)) {
        const isDir = ent.attrs && typeof ent.attrs.isDirectory === "function" ? ent.attrs.isDirectory() : /^d/.test(ent.longname || "");
        const childRemote = `${rNative}${sep}${ent.filename}`;
        const childLocal = join(lAbs, ent.filename);
        if (isDir) await rec(childRemote, childLocal);
        else {
          await this._get(childRemote, childLocal);
          count += 1;
        }
      }
    };
    await rec(remoteDir, localDir);
    return count;
  }

  // Upload a single local file to a remote native path, creating its parent dir.
  async putFile(localAbs, remoteNative) {
    const parent = String(remoteNative).replace(/[\\/][^\\/]*$/, "");
    if (parent && parent !== String(remoteNative)) await this.mkdirp(parent);
    await this._put(localAbs, remoteNative);
  }

  // Download a single remote file to a local path (creating its parent dir).
  async getFile(remoteNative, localAbs) {
    mkdirSync(dirname(localAbs), { recursive: true });
    await this._get(remoteNative, localAbs);
  }

  // See LocalExecutor.runGuiHelper. Remote: an SSH command lands in session 0
  // (non-interactive) whose window station can't reach the session-1 GUI, so
  // stage the helper + inputs via SFTP and run them through an INTERACTIVE
  // scheduled task (`schtasks /ru <user> /it`) that executes in session 1, then
  // read its out file back. `build(work, sep)` bakes the remote work-dir paths.
  async runGuiHelper(build, { timeoutSec = 60, taskName, user = this.cfg.user || "Administrator" } = {}) {
    const work = await this.mkdtemp("fpga-gui-");
    const { helperPs, files = [], outName = "out.txt" } = build(work, "\\");
    const localTmp = mkdtempSync(join(tmpdir(), "fpga-gui-"));
    try {
      for (const f of files) {
        const lp = join(localTmp, f.name);
        writeFileSync(lp, f.content, "utf8");
        await this.putFile(lp, `${work}\\${f.name}`);
      }
      const lHelper = join(localTmp, "helper.ps1");
      writeFileSync(lHelper, helperPs, "utf8");
      const helperPath = `${work}\\helper.ps1`;
      await this.putFile(lHelper, helperPath);
      const outPath = `${work}\\${outName}`;
      const tn = taskName || `fpga_gui_${process.pid}_${guiSeq++}`;
      const driver = `
$ErrorActionPreference='SilentlyContinue'
$out='${outPath}'
if (Test-Path $out) { Remove-Item $out -Force }
schtasks /delete /tn ${tn} /f *> $null
schtasks /create /tn ${tn} /tr "powershell -NoProfile -ExecutionPolicy Bypass -File ${helperPath}" /sc ONCE /st 23:59 /ru ${user} /it /f *> $null
schtasks /run /tn ${tn} *> $null
$deadline=(Get-Date).AddSeconds(${timeoutSec + 15})
while((Get-Date) -lt $deadline -and -not (Test-Path $out)){ Start-Sleep -Milliseconds 400 }
if (Test-Path $out){ "===OUT_BEGIN==="; Get-Content $out -Raw; "===OUT_END===" } else { "S1_NO_OUT" }
schtasks /delete /tn ${tn} /f *> $null
`;
      const b64 = Buffer.from(driver, "utf16le").toString("base64");
      const r = await this.exec(`powershell -NoProfile -EncodedCommand ${b64}`, { timeoutSec: timeoutSec + 40 });
      return { ...parseGuiDriverOut(r.stdout), work };
    } finally {
      try { rmSync(localTmp, { recursive: true, force: true }); } catch {}
    }
  }

  async close() {
    if (this._sftpConn) {
      try {
        this._sftpConn.end();
      } catch {}
      this._sftpConn = null;
    }
    if (this._conn) {
      this._conn.end();
      this._conn = null;
    }
  }
}

// Resolve a host config from pango-mcp.config.json `hosts`, with secrets allowed
// to come from the env file (PANGO_MCP_SSH_<id>_PASSWORD / _PASSPHRASE) so they
// need not sit in the JSON.
export function getHost(id) {
  const cfg = (CONFIG.hosts || {})[id];
  if (!cfg) return null;
  const env = toolEnv();
  return {
    id,
    ...cfg,
    password: cfg.password || env[`PANGO_MCP_SSH_${id}_PASSWORD`] || null,
    passphrase: cfg.passphrase || env[`PANGO_MCP_SSH_${id}_PASSPHRASE`] || null,
  };
}

export function listHosts() {
  return Object.keys(CONFIG.hosts || {});
}

// Get an Executor for a host id. Local-first + config-driven: an OMITTED host
// resolves from CONFIG.defaultHost (if set) else local — so "where the toolchain
// runs" is declared once in config, not threaded through every tool call by the
// agent. An explicit "local" always forces local. Otherwise an SshExecutor.
export function getExecutor(id) {
  if (id == null) id = CONFIG.defaultHost || "local";
  if (!id || id === "local") return LocalExecutor;
  const cfg = getHost(id);
  if (!cfg) throw new Error(`未知 host '${id}'；在 pango-mcp.config.json 的 hosts 配置，或用 host:"local"。已配置: ${listHosts().join(", ") || "(无)"}`);
  const transport = cfg.transport || "ssh";
  if (transport !== "ssh") throw new Error(`host '${id}' transport='${transport}' 暂不支持（目前仅 ssh）`);
  return new SshExecutor(cfg);
}
