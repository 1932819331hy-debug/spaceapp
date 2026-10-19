import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const WINDOWS_ACL_VERIFIED = "SPACEAPP_PRIVATE_ACL_VERIFIED";

// Node's mode/chmod do not implement owner/group/other isolation on Windows.
// Keep Windows system administrators and SYSTEM, like root on POSIX, in the
// trust boundary. Use SIDs so the policy also works on localized Windows hosts.
// Paths are data in an environment variable, never interpolated into the script.
const WINDOWS_PRIVATE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$createdDirectory = $false
try {
  $path = $env:SPACEAPP_PRIVATE_PATH
  $directory = $env:SPACEAPP_PRIVATE_DIRECTORY -eq '1'
  $createDirectory = $env:SPACEAPP_PRIVATE_CREATE_DIRECTORY -eq '1'
  $exclusive = $env:SPACEAPP_PRIVATE_EXCLUSIVE -eq '1'
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $sids = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
  function Assert-SafeDirectory($candidate) {
    $item = Get-Item -Force -LiteralPath $candidate
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Private storage requires a regular directory, not a reparse point.'
    }
    $security = Get-Acl -LiteralPath $candidate
    if ($sids -notcontains $security.GetOwner([Security.Principal.SecurityIdentifier]).Value) {
      throw 'Private storage requires a directory owned by this account or system administrators.'
    }
    $readOnly = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($entry in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          ($entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -or
          $sids -contains $entry.IdentityReference.Value) { continue }
      if (([int]$entry.FileSystemRights -band (-bnot $readOnly)) -ne 0) {
        throw 'Private storage refuses a directory writable or replaceable by another account.'
      }
    }
  }
  $parent = [IO.Path]::GetDirectoryName($path)
  while (-not (Test-Path -LiteralPath $parent)) {
    $parent = [IO.Path]::GetDirectoryName($parent)
    if ([string]::IsNullOrEmpty($parent)) { throw 'No trusted parent directory exists.' }
  }
  Assert-SafeDirectory $parent
  $exists = Test-Path -LiteralPath $path
  if ($exclusive -and $exists) { throw 'Private staging path already exists.' }
  if ($directory -and $exists) { Assert-SafeDirectory $path }
  if ($directory) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($owner)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $sids) {
    $identity = [Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  if ($directory -and -not $exists -and $createDirectory) {
    # This Windows PowerShell/.NET Framework overload applies the security
    # descriptor during creation, without first exposing an inherited ACL.
    [IO.Directory]::CreateDirectory($path, $acl) | Out-Null
    $createdDirectory = $true
  } else {
    $item = Get-Item -Force -LiteralPath $path
    if ($item.PSIsContainer -ne $directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Expected a regular private file or directory, not a reparse point.'
    }
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  $actual = Get-Acl -LiteralPath $path
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
    throw 'Private ACL ownership or inheritance could not be verified.'
  }
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $sids.Count) { throw 'Unexpected private ACL entries.' }
  foreach ($sid in $sids) {
    $matching = @($rules | Where-Object {
      $_.IdentityReference.Value -eq $sid -and
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
      $_.InheritanceFlags -eq $inheritance -and
      $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
      -not $_.IsInherited
    })
    if ($matching.Count -ne 1) { throw 'Private ACL rights could not be verified.' }
  }
  Write-Output '${WINDOWS_ACL_VERIFIED}'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  if ($createdDirectory) {
    try { [IO.Directory]::Delete($path, $false) } catch { }
  }
  exit 1
}
`;

export async function restrictPrivatePath(path, {
  directory = false,
  createDirectory = false,
  exclusive = false,
  platform = process.platform,
  execute = executeFile
} = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("A private file path must be absolute and contain no null bytes.");
  }
  if (platform !== "win32") {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    if (!/^[A-Za-z]:[\\/]/.test(systemRoot)) throw new Error("SystemRoot must be an absolute Windows drive path.");
    const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await execute(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_ACL_SCRIPT
    ], {
      env: {
        ...process.env,
        SPACEAPP_PRIVATE_PATH: path,
        SPACEAPP_PRIVATE_DIRECTORY: directory ? "1" : "0",
        SPACEAPP_PRIVATE_CREATE_DIRECTORY: createDirectory ? "1" : "0",
        SPACEAPP_PRIVATE_EXCLUSIVE: exclusive ? "1" : "0"
      },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8"
    });
    if (result.stdout.trim() !== WINDOWS_ACL_VERIFIED) {
      throw new Error("PowerShell did not confirm the private ACL after reading it back.");
    }
  } catch (error) {
    throw new Error(`Cannot enforce private Windows permissions for ${path}. Use storage controlled by your Windows account or system administrators. No new private data will be written.`, { cause: error });
  }
}

export async function mkdirPrivate(path) {
  if (process.platform === "win32") {
    await restrictPrivatePath(path, { directory: true, createDirectory: true });
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await restrictPrivatePath(path, { directory: true });
}

// Windows directories are private at creation: tightening an initially public
// directory would not revoke another account's existing WRITE_DAC handle.
// The file also gets an explicit protected ACL before leaving its private
// staging directory, so the final parent cannot supply a permissive file ACL.
export async function createPrivateStagingFile(destination, { protect = restrictPrivatePath } = {}) {
  const windows = process.platform === "win32";
  const directory = windows
    ? join(dirname(destination), `.spaceapp-private-${randomUUID()}`)
    : await mkdtemp(join(dirname(destination), ".spaceapp-private-"));
  let directoryReady = !windows;
  try {
    await protect(directory, { directory: true, createDirectory: windows, exclusive: windows });
    directoryReady = true;
    const path = join(directory, "archive");
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
    await protect(path);
    return { path, directory };
  } catch (error) {
    if (directoryReady) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
