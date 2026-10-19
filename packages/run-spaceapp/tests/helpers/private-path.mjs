import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const powershell = win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function windowsPowerShellEnvironment(values) {
  const environment = { ...process.env, ...values };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "PSMODULEPATH") delete environment[name];
  }
  environment.PSModulePath = win32.join(win32.dirname(powershell), "Modules");
  return environment;
}

// Independent readback: do not use the production permission setter or its
// success marker to decide whether the resulting file is private.
export async function windowsAcl(path) {
  const { stdout } = await executeFile(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:SPACEAPP_TEST_ACL_PATH
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; type = [int]$_.AccessControlType; rights = [int]$_.FileSystemRights;
     inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags; inherited = $_.IsInherited }
})
@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
   currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
   protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`
  ], { env: windowsPowerShellEnvironment({ SPACEAPP_TEST_ACL_PATH: path }), windowsHide: true, timeout: 30_000 });
  return JSON.parse(stdout.trim());
}

export async function assertPrivatePath(path, { directory = false, protectedDacl = directory } = {}) {
  const metadata = await stat(path);
  assert.equal(directory ? metadata.isDirectory() : metadata.isFile(), true);
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, directory ? 0o700 : 0o600);
    return;
  }
  const acl = await windowsAcl(path);
  const allowed = new Set([acl.currentUser, "S-1-5-18", "S-1-5-32-544"]);
  assert.ok(allowed.has(acl.owner), `Unexpected private path owner: ${acl.owner}`);
  if (protectedDacl) assert.equal(acl.protected, true);
  assert.equal(acl.rules.length, allowed.size);
  for (const rule of acl.rules) {
    assert.ok(allowed.has(rule.sid), `Unexpected principal on private path: ${rule.sid}`);
    assert.equal(rule.type, 0, "Only the intended Allow entries should remain");
    assert.equal(rule.rights, 0x1f01ff, "The trusted principal must retain FullControl");
    if (directory) {
      assert.equal(rule.inheritance, 3, "New files and directories must inherit the private ACL");
      assert.equal(rule.propagation, 0);
    }
  }
  assert.deepEqual(new Set(acl.rules.map((rule) => rule.sid)), allowed);
}

// Only callers' disposable fixture paths are passed here. Seed a deliberately
// public Everyone grant so the Windows tests cannot pass on a private temp default.
export async function grantEveryoneInFixture(path, { directory = false, writable = false } = {}) {
  await executeFile(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$path = $env:SPACEAPP_TEST_ACL_PATH
$acl = Get-Acl -LiteralPath $path
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$inheritance = [Security.AccessControl.InheritanceFlags]::None
if ($env:SPACEAPP_TEST_ACL_DIRECTORY -eq '1') { $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
$rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
if ($env:SPACEAPP_TEST_ACL_WRITABLE -eq '1') { $rights = [Security.AccessControl.FileSystemRights]::FullControl }
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`
  ], {
    env: windowsPowerShellEnvironment({
      SPACEAPP_TEST_ACL_PATH: path,
      SPACEAPP_TEST_ACL_DIRECTORY: directory ? "1" : "0",
      SPACEAPP_TEST_ACL_WRITABLE: writable ? "1" : "0"
    }),
    windowsHide: true,
    timeout: 30_000
  });
}
