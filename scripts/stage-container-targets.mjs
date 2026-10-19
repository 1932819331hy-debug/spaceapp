#!/usr/bin/env node
import { builtinModules, isBuiltin } from "node:module";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const nodeBuiltinNames = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const excludedOptionalUrlResources = new Map([
  ["scripts/space-media-capture.mjs", "The optional media-capture helper is intentionally absent from the public source tree."],
  ["scripts/space-design-render.mjs", "Design is an optional public module disabled by default, but its renderer is excluded from the public source tree; manually enabling Design rendering remains unsupported."]
]);

export const containerTargetDefinitions = Object.freeze({
  core: {
    entrypoints: [
      "apps/api/dist/server.js",
      "apps/worker/dist/worker.js",
      "apps/web/server.mjs",
      "packages/db/dist/migrate.js"
    ],
    extraPaths: [
      "apps/web/dist",
      "apps/web/public/brand",
      "apps/api/package.json",
      "apps/api/dist/databases/sqlite-worker.py",
      "agent-skills",
      "demos",
      "packages/db/migrations",
      "packages/gateway/grammars",
      "scripts/reset-owner-password.mjs",
      "scripts/rotate-owner-setup-token.mjs",
      "scripts/portable-backup.mjs",
      "scripts/portable-restore.mjs"
    ],
    runtimeDependencies: [],
    omittedDependencies: ["node-pty"]
  },
  browser: {
    // Keep the repository's migration runner available to the container smoke
    // driver. It mounts migration SQL read-only from the checkout and uses this
    // real runner to initialize an isolated PostgreSQL database.
    entrypoints: ["apps/api/dist/browser-host-main.js", "packages/db/dist/migrate.js"],
    extraPaths: ["apps/api/package.json", "apps/api/dist/databases/sqlite-worker.py"],
    runtimeDependencies: [],
    omittedDependencies: []
  },
  cli: {
    entrypoints: ["packages/cli-host/dist/main.js"],
    extraPaths: ["agent-skills"],
    // node-pty is resolved through createRequire at runtime, so it is not
    // discoverable from a static import scan.
    runtimeDependencies: ["node-pty"],
    omittedDependencies: []
  }
});

function packageNameFromSpecifier(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function moduleSpecifiers(source) {
  const found = new Map();
  const patterns = [
    { mode: "import", pattern: /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g },
    { mode: "import", pattern: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g },
    { mode: "require", pattern: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g }
  ];
  for (const { mode, pattern } of patterns) {
    for (const match of source.matchAll(pattern)) found.set(`${mode}\0${match[1]}`, { mode, specifier: match[1] });
  }
  return [...found.values()];
}

function urlResources(source) {
  const resources = [];
  const filePattern = String.raw`([^"']+\.(?:[cm]?js|json|wasm|node|sql|svg|png|jpe?g|webp|woff2?|py))`;
  const patterns = [
    new RegExp(String.raw`\bnew\s+URL\(\s*["']${filePattern}["']\s*,\s*import\.meta\.url\s*\)`, "g"),
    new RegExp(String.raw`\bnew\s+URL\(\s*["']${filePattern}["']\s*,\s*import\.meta\.resolve\(\s*["']([^"']+)["']\s*\)\s*\)`, "g")
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of source.matchAll(pattern)) {
      resources.push({ path: match[1], packageName: index === 0 ? undefined : match[2] });
    }
  }
  return resources;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function findWorkspaces(sourceRoot) {
  const workspaces = new Map();
  for (const area of ["apps", "packages"]) {
    const areaRoot = join(sourceRoot, area);
    for (const entry of await readdir(areaRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspaceRoot = join(areaRoot, entry.name);
      const manifestPath = join(workspaceRoot, "package.json");
      if (!(await exists(manifestPath))) continue;
      const manifest = await readJson(manifestPath);
      if (typeof manifest.name === "string") {
        workspaces.set(manifest.name, { root: workspaceRoot, manifest });
      }
    }
  }
  return workspaces;
}

function workspaceEntry(workspace, specifier) {
  const suffix = specifier.slice(workspace.manifest.name.length);
  const exportsMap = workspace.manifest.exports;
  if (suffix && exportsMap && typeof exportsMap === "object") {
    const exportKey = `.${suffix}`;
    const entry = exportsMap[exportKey];
    const selected = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
    if (typeof selected === "string" && selected.startsWith("./")) {
      return join(workspace.root, selected);
    }
  }
  if (!suffix) {
    const mainExport = exportsMap && typeof exportsMap === "object"
      ? (typeof exportsMap["."] === "string" ? exportsMap["."] : exportsMap["."]?.import ?? exportsMap["."]?.default)
      : undefined;
    const main = mainExport ?? workspace.manifest.module ?? workspace.manifest.main;
    if (typeof main === "string") return join(workspace.root, main);
  }
  return join(workspace.root, suffix.replace(/^\//, ""));
}

async function resolveRelativeFile(sourceRoot, importerPath, specifier) {
  const candidate = resolve(dirname(importerPath), specifier);
  const candidates = [
    candidate,
    `${candidate}.js`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    `${candidate}.json`,
    `${candidate}.node`,
    join(candidate, "index.js"),
    join(candidate, "index.mjs"),
    join(candidate, "index.cjs"),
    join(candidate, "index.json")
  ];
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    const actual = await realpath(path);
    const rel = relative(sourceRoot, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Runtime import escapes source tree: ${importerPath} -> ${specifier}`);
    }
    return actual;
  }
  throw new Error(`Cannot resolve local runtime import ${specifier} from ${importerPath}`);
}

async function findInstalledPackageRoot(sourceRoot, packageName, fromDirectory) {
  let current = fromDirectory;
  while (current === sourceRoot || current.startsWith(`${sourceRoot}${sep}`)) {
    const candidate = join(current, "node_modules", ...packageName.split("/"));
    if (await exists(join(candidate, "package.json"))) return realpath(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rootCandidate = join(sourceRoot, "node_modules", ...packageName.split("/"));
  if (await exists(join(rootCandidate, "package.json"))) return realpath(rootCandidate);
  throw new Error(`Cannot resolve installed dependency ${packageName} from ${fromDirectory}`);
}

async function copyPath(sourceRoot, targetRoot, sourcePath) {
  const absoluteSource = resolve(sourceRoot, sourcePath);
  if (!(await exists(absoluteSource))) throw new Error(`Required runtime path is missing: ${sourcePath}`);
  const relativePath = relative(sourceRoot, absoluteSource);
  const destination = join(targetRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(absoluteSource, destination, { recursive: true, dereference: true, force: true });
}

async function listOutputPaths(root, directory = root) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute);
    paths.push(relativePath);
    if (entry.isDirectory()) paths.push(...await listOutputPaths(root, absolute));
  }
  return paths;
}

export async function stageContainerTarget({ source = repoRoot, output, target }) {
  const sourceRoot = await realpath(resolve(source));
  if (!output) throw new Error("stageContainerTarget requires an output directory");
  const definition = containerTargetDefinitions[target];
  if (!definition) throw new Error(`Unknown container target: ${target}`);
  const targetRoot = resolve(output);
  const workspaces = await findWorkspaces(sourceRoot);
  const omitted = new Set(definition.omittedDependencies);
  const copiedWorkspaces = new Set();
  const copiedExternal = new Set();
  const resolutionEdges = [];
  const excludedOptionalResources = [];
  const pendingFiles = definition.entrypoints.map((path) => resolve(sourceRoot, path));
  const outputNodeModules = join(targetRoot, "node_modules");
  const sourceNodeModules = join(sourceRoot, "node_modules");
  async function copyWorkspace(name) {
    if (copiedWorkspaces.has(name)) return;
    const workspace = workspaces.get(name);
    if (!workspace) throw new Error(`Unknown runtime workspace: ${name}`);
    copiedWorkspaces.add(name);
    const workspacePath = relative(sourceRoot, workspace.root);
    await copyPath(sourceRoot, targetRoot, join(workspacePath, "package.json"));
    const linkPath = join(outputNodeModules, ...name.split("/"));
    const relativeTarget = relative(dirname(linkPath), join(targetRoot, relative(sourceRoot, workspace.root)));
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(relativeTarget, linkPath, "dir");
  }

  async function copyExternal(name, importerPath) {
    if (omitted.has(name)) return;
    if (workspaces.has(name)) {
      await copyWorkspace(name);
      pendingFiles.push(workspaceEntry(workspaces.get(name), name));
      return;
    }
    const packageRoot = await findInstalledPackageRoot(sourceRoot, name, dirname(importerPath));
    const nodeModulesReal = await realpath(sourceNodeModules);
    const relativeToRootNodeModules = relative(nodeModulesReal, packageRoot);
    const isRootDependency = relativeToRootNodeModules !== ".." &&
      !relativeToRootNodeModules.startsWith(`..${sep}`) && !isAbsolute(relativeToRootNodeModules);
    const packageRelative = isRootDependency
      ? join("node_modules", relativeToRootNodeModules)
      : relative(sourceRoot, packageRoot);
    if (packageRelative === ".." || packageRelative.startsWith(`..${sep}`) || isAbsolute(packageRelative)) {
      throw new Error(`Dependency path is outside the source tree: ${name} at ${packageRoot}`);
    }
    if (copiedExternal.has(packageRelative)) return;
    copiedExternal.add(packageRelative);
    const outputPath = join(targetRoot, packageRelative);
    await mkdir(dirname(outputPath), { recursive: true });
    await cp(packageRoot, outputPath, { recursive: true, dereference: true, force: true });

    const manifest = await readJson(join(packageRoot, "package.json"));
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    };
    for (const dependencyName of Object.keys(dependencies)) {
      if (omitted.has(dependencyName)) continue;
      try {
        await copyExternal(dependencyName, join(packageRoot, "package.json"));
      } catch (error) {
        const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, dependencyName) ||
          manifest.peerDependenciesMeta?.[dependencyName]?.optional === true;
        if (!optional) throw error;
      }
    }
  }

  async function enqueueModule(importerPath, specifier, mode) {
    const from = relative(sourceRoot, importerPath);
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const resolved = await resolveRelativeFile(sourceRoot, importerPath, specifier);
      pendingFiles.push(resolved);
      resolutionEdges.push({ from, specifier, mode });
      return;
    }
    if (nodeBuiltinNames.has(specifier) || (specifier.startsWith("node:") && isBuiltin(specifier))) {
      resolutionEdges.push({ from, specifier, mode, builtin: true });
      return;
    }
    const name = packageNameFromSpecifier(specifier);
    if (omitted.has(name)) {
      resolutionEdges.push({ from, specifier, mode, omitted: true });
      return;
    }
    const workspace = workspaces.get(name);
    if (workspace) {
      await copyWorkspace(name);
      pendingFiles.push(workspaceEntry(workspace, specifier));
      resolutionEdges.push({ from, specifier, mode });
      return;
    }
    await copyExternal(name, importerPath);
    resolutionEdges.push({ from, specifier, mode });
  }

  async function enqueueUrlResource(importerPath, resource) {
    let basePath = importerPath;
    if (resource.packageName) {
      const workspace = workspaces.get(packageNameFromSpecifier(resource.packageName));
      if (workspace) {
        basePath = workspaceEntry(workspace, resource.packageName);
      } else {
        const packageRoot = await findInstalledPackageRoot(sourceRoot, packageNameFromSpecifier(resource.packageName), dirname(importerPath));
        const manifest = await readJson(join(packageRoot, "package.json"));
        const packagePath = workspaceEntry({ root: packageRoot, manifest }, resource.packageName);
        basePath = packagePath;
      }
    }
    try {
      pendingFiles.push(await resolveRelativeFile(sourceRoot, basePath, resource.path));
    } catch (error) {
      const sourceRelative = relative(sourceRoot, resolve(dirname(basePath), resource.path));
      const missingExactResource = error instanceof Error &&
        error.message === `Cannot resolve local runtime import ${resource.path} from ${basePath}`;
      const reason = excludedOptionalUrlResources.get(sourceRelative);
      // Only the exact public-export omissions are optional. Record them for auditability;
      // every other missing URL resource remains a staging error.
      if (target === "core" && missingExactResource && reason) {
        excludedOptionalResources.push({
          path: sourceRelative,
          importer: relative(sourceRoot, importerPath),
          resource: resource.path,
          reason
        });
        return;
      }
      throw error;
    }
  }

  await copyPath(sourceRoot, targetRoot, "package.json");
  for (const name of definition.runtimeDependencies) {
    await copyExternal(name, resolve(sourceRoot, "package.json"));
  }

  for (const entrypoint of pendingFiles) {
    if (!(await exists(entrypoint))) throw new Error(`Runtime entrypoint is missing: ${relative(sourceRoot, entrypoint)}`);
  }

  const visitedFiles = new Set();
  while (pendingFiles.length > 0) {
    const sourcePath = await realpath(pendingFiles.pop());
    const sourceRelative = relative(sourceRoot, sourcePath);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
      throw new Error(`Runtime file escapes source tree: ${sourcePath}`);
    }
    if (visitedFiles.has(sourcePath)) continue;
    visitedFiles.add(sourcePath);
    await copyPath(sourceRoot, targetRoot, sourceRelative);
    const source = await readFile(sourcePath, "utf8");
    for (const { specifier, mode } of moduleSpecifiers(source)) await enqueueModule(sourcePath, specifier, mode);
    for (const resource of urlResources(source)) await enqueueUrlResource(sourcePath, resource);
  }

  for (const path of definition.extraPaths) await copyPath(sourceRoot, targetRoot, path);
  const stagedPaths = (await listOutputPaths(targetRoot)).sort();
  await writeFile(join(targetRoot, "container-runtime-manifest.json"), JSON.stringify({
    target,
    stagedPaths,
    resolutionEdges,
    excludedOptionalResources: excludedOptionalResources.sort((a, b) =>
      a.path.localeCompare(b.path) || a.importer.localeCompare(b.importer))
  }, null, 2) + "\n");
  return {
    target,
    workspaceCount: copiedWorkspaces.size,
    externalPackageCount: copiedExternal.size,
    fileCount: visitedFiles.size,
    stagedPathCount: stagedPaths.length
  };
}

function parseArgs(args) {
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  return {
    source: value("--source") ?? repoRoot,
    output: value("--output"),
    target: value("--target")
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { source, output, target } = parseArgs(process.argv.slice(2));
    if (!output) throw new Error("Usage: stage-container-targets.mjs --source <repo> --output <dir> [--target <core|browser|cli>]");
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const targets = target ? [target] : Object.keys(containerTargetDefinitions);
    for (const name of targets) {
      const result = await stageContainerTarget({ source, output: join(output, name), target: name });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
