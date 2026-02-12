#!/usr/bin/env bash
# 检查当前 npm 工程中所有生产依赖的开源 license，并统计每种 license 对应的包数量。
# 用法: ./scripts/check-licenses.sh [--details]

set -e

DETAILS=false
for arg in "$@"; do
  if [ "$arg" = "--details" ]; then
    DETAILS=true
    break
  fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "package.json" ]; then
  echo "错误: 未找到 package.json，请在项目根目录下运行此脚本。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_SCRIPT="$SCRIPT_DIR/.check-licenses-run.cjs"
trap 'rm -f "$TMP_SCRIPT"' EXIT

if [ "$DETAILS" = true ]; then
  export NODE_DETAILS=1
else
  export NODE_DETAILS=0
fi

cat > "$TMP_SCRIPT" << 'NODESCRIPT'
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const nodeModules = path.join(root, "node_modules");
const showDetails = process.env.NODE_DETAILS === "1";

function getPackageLicense(pkgName) {
  const parts = pkgName.split("/");
  const pkgPath = parts[0].startsWith("@")
    ? path.join(nodeModules, parts[0], parts.slice(1).join("/"))
    : path.join(nodeModules, pkgName);
  const pkgJsonPath = path.join(pkgPath, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return "(unknown)";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    const lic = pkg.license;
    if (typeof lic === "string") return lic || "(none)";
    if (lic && typeof lic === "object" && lic.type) return lic.type;
    if (pkg.licenses && Array.isArray(pkg.licenses) && pkg.licenses[0])
      return pkg.licenses[0].type || String(pkg.licenses[0]);
    return "(none)";
  } catch (_) {
    return "(unknown)";
  }
}

let tree = {};
try {
  const out = require("child_process").execSync("npm ls --omit=dev --json", {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  tree = JSON.parse(out);
} catch (e) {
  if (e.stdout) {
    try {
      tree = JSON.parse(e.stdout);
    } catch (_) {}
  }
}

function collectDeps(obj, set) {
  if (!obj || !obj.dependencies) return;
  for (const [name, dep] of Object.entries(obj.dependencies)) {
    if (dep && !dep.extraneous) {
      set.add(name);
      if (dep.dependencies) collectDeps(dep, set);
    }
  }
}

const packages = new Set();
collectDeps(tree, packages);

const byLicense = {};
for (const pkg of packages) {
  const license = getPackageLicense(pkg);
  if (!byLicense[license]) byLicense[license] = [];
  byLicense[license].push(pkg);
}

const entries = Object.entries(byLicense).sort((a, b) => b[1].length - a[1].length);
const maxLicLen = Math.max(8, ...entries.map((e) => e[0].length));
const maxCountLen = 5;
const headerLic = "LICENSE".padEnd(maxLicLen);
const headerCount = "COUNT".padStart(maxCountLen);
console.log(headerLic + "  " + headerCount);
console.log("-".repeat(maxLicLen) + "  " + "-".repeat(maxCountLen));
for (const [lic, pkgs] of entries) {
  const name = lic.padEnd(maxLicLen);
  const count = String(pkgs.length).padStart(maxCountLen);
  console.log(name + "  " + count);
  if (showDetails && pkgs.length > 0) {
    for (const p of pkgs.sort()) console.log("  - " + p);
  }
}
NODESCRIPT

node "$TMP_SCRIPT"
