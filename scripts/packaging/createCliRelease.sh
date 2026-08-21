#!/bin/bash

set -e

# Restore manifests changed for a release (nightly version, plugin SDK alignment).
restore_package_json() {
  if [ -f "package.json.backup" ]; then
    echo "Restoring original package.json..."
    mv package.json.backup package.json
  fi
  if [ -f "packages/plugin-sdk/package.json.backup" ]; then
    echo "Restoring original plugin package.json..."
    mv packages/plugin-sdk/package.json.backup packages/plugin-sdk/package.json
  fi
}

# Set trap to ensure cleanup even if script fails
trap restore_package_json EXIT

# Parse command line arguments
RELEASE_TYPE=""
USE_YESTERDAY=false
PUBLISH=false
DRY_RUN=false

print_usage() {
  echo "Usage: $0 --stable|--nightly [--yesterday] [--publish] [--dry-run]"
  echo ""
  echo "  --stable     Build stable CLI and plugin SDK release packages."
  echo "  --nightly    Build nightly CLI and plugin SDK release packages."
  echo "  --yesterday Use yesterday's date for a nightly release."
  echo "  --publish    Reserved for compatibility; automatic publishing is disabled."
  echo "               The script never publishes. Publish manually as instructed at the end."
  echo "  --dry-run    Build and validate both packages locally without publishing."
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --stable)
      RELEASE_TYPE="stable"
      shift
      ;;
    --nightly)
      RELEASE_TYPE="nightly"
      shift
      ;;
    --yesterday)
      USE_YESTERDAY=true
      shift
      ;;
    --publish)
      PUBLISH=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      PUBLISH=true
      shift
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option $1"
      print_usage
      exit 1
      ;;
  esac
done

# Validate that either --stable or --nightly is provided
if [ -z "$RELEASE_TYPE" ]; then
  echo "ERROR: You must specify either --stable or --nightly"
  print_usage
  exit 1
fi

# --yesterday is only valid with --nightly
if [ "$USE_YESTERDAY" = true ] && [ "$RELEASE_TYPE" != "nightly" ]; then
  echo "ERROR: --yesterday can only be used with --nightly"
  exit 1
fi

# Set release directory
if [ "$RELEASE_TYPE" = "nightly" ]; then
  RELEASE_DIR="dist/cli-release-nightly"
  PLUGIN_RELEASE_DIR="dist/plugin-release-nightly"
  NPM_TAG="nightly"
else
  RELEASE_DIR="dist/cli-release"
  PLUGIN_RELEASE_DIR="dist/plugin-release"
  NPM_TAG="latest"
fi

echo "=== Building OpenDesk CLI $RELEASE_TYPE Release ==="

# Check if release directory exists
if [ -d "$RELEASE_DIR" ]; then
  echo "WARNING: $RELEASE_DIR directory already exists!"
  read -p "Do you want to delete it and continue? (Y/n): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    echo "Deleting existing $RELEASE_DIR directory..."
    rm -rf "$RELEASE_DIR"
  else
    echo "Aborting. Please manually delete $RELEASE_DIR and try again."
    exit 1
  fi
fi

if [ -d "$PLUGIN_RELEASE_DIR" ]; then
  echo "WARNING: $PLUGIN_RELEASE_DIR directory already exists!"
  read -p "Do you want to delete it and continue? (Y/n): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    echo "Deleting existing $PLUGIN_RELEASE_DIR directory..."
    rm -rf "$PLUGIN_RELEASE_DIR"
  else
    echo "Aborting. Please manually delete $PLUGIN_RELEASE_DIR and try again."
    exit 1
  fi
fi

# Step 1: Handle versioning for nightly builds if needed
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 1: Preparing nightly version..."
  # Save original package.json first to restore later
  cp package.json package.json.backup
  # Get current version
  CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
  # Remove any existing nightly suffix (e.g., -nightly-20260227)
  CLEAN_VERSION=$(echo "$CURRENT_VERSION" | sed 's/-nightly-.*$//')
  # Generate date in YYYYMMDD format
  if [ "$USE_YESTERDAY" = true ]; then
    DATE=$(date -d "yesterday" +%Y%m%d 2>/dev/null || date -v-1d +%Y%m%d)
  else
    DATE=$(date +%Y%m%d)
  fi
  NIGHTLY_VERSION="${CLEAN_VERSION}-nightly-${DATE}"
  echo "Setting nightly version: $NIGHTLY_VERSION"
  # Directly modify package.json instead of using npm version
  sed -i.bak "s/\"version\": *\"[^\"]*\"/\"version\": \"$NIGHTLY_VERSION\"/" package.json
  rm -f package.json.bak
fi

# Align the plugin SDK version with the CLI version so that both packages are
# published under the same version. The manifest is backed up and restored on exit.
echo "Aligning plugin SDK version with the CLI version..."
cp packages/plugin-sdk/package.json packages/plugin-sdk/package.json.backup
PLUGIN_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^\"]*\)".*/\1/')
sed -i.bak "s/\"version\": *\"[^\"]*\"/\"version\": \"$PLUGIN_VERSION\"/" packages/plugin-sdk/package.json
rm -f packages/plugin-sdk/package.json.bak

# Step 2: Build CLI
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 2: Running npm run build-cli..."
else
  echo "Step 1: Running npm run build-cli..."
fi
npm run build-cli

# Step 3: Create cli-release directory and copy built files
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 3: Creating $RELEASE_DIR directory..."
else
  echo "Step 2: Creating $RELEASE_DIR directory..."
fi
mkdir -p "$RELEASE_DIR"

echo "Copying built CLI files..."
cp dist/cli/opendesk "$RELEASE_DIR/opendesk"

echo "Creating preinstall script for Windows shebang patching..."
# 构建产物使用 #!/bin/sh polyglot 以兼容鸿蒙 HiShell（env 在 /bin/env 而非 /usr/bin/env），
# npm 在 Windows 上创建 bin link 前会先运行 preinstall，此时将 shebang 改为 #!/usr/bin/env node，
# 使 cmd-shim 正确生成使用 node.exe 的 .cmd/.ps1 wrapper
cat > "$RELEASE_DIR/preinstall.cjs" << 'PREINSTALL_EOF'
const fs = require('fs');
const path = require('path');
if (process.platform === 'win32') {
    const target = path.join(__dirname, 'opendesk');
    const content = fs.readFileSync(target, 'utf8');
    if (content.startsWith('#!/bin/sh\n')) {
        fs.writeFileSync(target, '#!/usr/bin/env node\n' + content.slice('#!/bin/sh\n'.length));
    }
}
PREINSTALL_EOF

# Step 4: Create package.json with version from root package.json
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 4: Creating package.json..."
else
  echo "Step 3: Creating package.json..."
fi
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

cat > "$RELEASE_DIR/package.json" << EOF
{
  "name": "@bitclub.ai/opendesk-cli",
  "version": "${VERSION}",
  "description": "OpenDesk CLI - An all-in-one ai studio for productivity scenarios",
  "license": "MulanPSL-2.0",
  "author": "uv0xab",
  "type": "module",
  "main": "./opendesk",
  "bin": {
    "opendesk": "./opendesk"
  },
  "scripts": {
    "preinstall": "node preinstall.cjs"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "dependencies": {
    "hnsw": "^1.1.1",
    "node-sqlite3-wasm": "^0.8.55",
    "number-to-alphabet": "^1.0.0",
    "vectra": "^0.11.1",
    "esbuild": "^0.27.3",
    "unpdf": "^1.4.0"
  }
}
EOF

# Step 5: Create .npmrc for a manual npm publish (optional)
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 5: Preparing .npmrc (optional)..."
else
  echo "Step 4: Preparing .npmrc (optional)..."
fi

if [ -n "$NPM_TOKEN" ]; then
cat > "$RELEASE_DIR/.npmrc" << EOF
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=$NPM_TOKEN
EOF
  echo "Created $RELEASE_DIR/.npmrc using NPM_TOKEN for manual npm publish."
else
  echo "NPM_TOKEN is not set; skipping .npmrc creation."
  echo "Set NPM_TOKEN if you want the release dir to carry publish credentials, or log in via 'npm login' before publishing."
fi

# Step 6: Copy README file
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 6: Copying README file..."
else
  echo "Step 5: Copying README file..."
fi
cp docs/readmes/README_cli.md "$RELEASE_DIR/README.md"

# Step 7: Copy manual.html (if exists)
if [ -f "docs/manual.html" ]; then
  if [ "$RELEASE_TYPE" = "nightly" ]; then
    echo "Step 7: Copying manual.html..."
  else
    echo "Step 6: Copying manual.html..."
  fi
  cp docs/manual.html "$RELEASE_DIR/manual.html"
else
  if [ "$RELEASE_TYPE" = "nightly" ]; then
    echo "Step 7: Skipping manual.html (not found)..."
  else
    echo "Step 6: Skipping manual.html (not found)..."
  fi
fi

echo "Preparing plugin SDK release..."
mkdir -p "$PLUGIN_RELEASE_DIR"
npm --prefix packages/plugin-sdk run build

echo "Copying built plugin SDK files..."
cp -R packages/plugin-sdk/dist "$PLUGIN_RELEASE_DIR/dist"

echo "Creating publish-ready package.json..."
# The manifest version has already been aligned with the CLI version above.
# Drop the build scripts so that publish/install never re-runs the rollup
# build against the release directory (which has no src/).
cp packages/plugin-sdk/package.json "$PLUGIN_RELEASE_DIR/package.json"
node -e "const fs = require('fs'); const p = process.argv[1]; const j = JSON.parse(fs.readFileSync(p, 'utf8')); delete j.scripts; fs.writeFileSync(p, JSON.stringify(j, null, 4) + '\n');" "$PLUGIN_RELEASE_DIR/package.json"

echo "Copying README file..."
cp packages/plugin-sdk/README.md "$PLUGIN_RELEASE_DIR/README.md"

if [ -n "$NPM_TOKEN" ]; then
  cp "$RELEASE_DIR/.npmrc" "$PLUGIN_RELEASE_DIR/.npmrc"
fi

echo "Validating CLI release package..."
# Prefix with ./ so npm treats it as a local directory rather than a GitHub
# shorthand spec (e.g. "dist/cli-release" would be parsed as github:dist/cli-release).
npm pack "./$RELEASE_DIR" --dry-run --json > /dev/null
echo "Validating plugin SDK release package..."
npm pack "./$PLUGIN_RELEASE_DIR" --dry-run --json > /dev/null

# Automatic publishing is intentionally disabled: this script only builds and
# validates the release packages. Publishing is always done manually by the user.
if [ "$PUBLISH" = true ]; then
  echo "NOTE: Automatic publishing is disabled by design."
  echo "      The packages below are ready; please publish them manually as instructed."
  echo ""
fi

# Step 8: Success message
echo "=== CLI and Plugin SDK Release Packages Created Successfully ==="
echo "Release location: $RELEASE_DIR"
echo "Plugin SDK release: $PLUGIN_RELEASE_DIR"
echo ""
echo "To install locally:"
echo "  cd $RELEASE_DIR && npm install"
echo "  Note: Local install via 'npm install' does NOT make 'opendesk' globally accessible."
echo "  For global access, use one of the following:"
echo "    cd $RELEASE_DIR && npm link          # Create a global symlink (recommended for testing)"
echo "    npm install -g ./$RELEASE_DIR        # Install globally from local directory"
echo "  cd $PLUGIN_RELEASE_DIR && npm install"
echo "    npm install -g ./$PLUGIN_RELEASE_DIR # Install plugin SDK globally"
echo ""
echo "To publish manually, publish the CLI first and then the plugin SDK:"
echo "  (cd $RELEASE_DIR && npm publish --access public --tag $NPM_TAG)"
echo "  (cd $PLUGIN_RELEASE_DIR && npm publish --access public --tag $NPM_TAG)"
echo ""
echo "This script never publishes automatically. Review the packages above,"
echo "then run the publish commands yourself when ready."
