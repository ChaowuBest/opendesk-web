#!/bin/bash

set -e

# Function to restore package.json if backup exists
restore_package_json() {
  if [ -f "package.json.backup" ]; then
    echo "Restoring original package.json..."
    mv package.json.backup package.json
  fi
}

# Set trap to ensure cleanup even if script fails
trap restore_package_json EXIT

# Parse command line arguments
RELEASE_TYPE=""
USE_YESTERDAY=false
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
    *)
      echo "ERROR: Unknown option $1"
      echo "Usage: $0 --stable|--nightly [--yesterday]"
      exit 1
      ;;
  esac
done

# Validate that either --stable or --nightly is provided
if [ -z "$RELEASE_TYPE" ]; then
  echo "ERROR: You must specify either --stable or --nightly"
  echo "Usage: $0 --stable|--nightly [--yesterday]"
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
else
  RELEASE_DIR="dist/cli-release"
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
    "node": ">=20.0.0"
  },
  "dependencies": {
    "hnsw": "^1.1.1",
    "node-sqlite3-wasm": "^0.8.55",
    "number-to-alphabet": "^1.0.0",
    "vectra": "^0.11.1",
    "esbuild": "^0.27.3",
    "unpdf": "^1.4.0"
  },
  "optionalDependencies": {
    "better-sqlite3": "^12.6.2",
    "sqlite-vec": "^0.1.7-alpha.2"
  }
}
EOF

# Step 5: Create .npmrc to ensure publishing to official npm registry
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "Step 5: Creating .npmrc..."
else
  echo "Step 4: Creating .npmrc..."
fi
if [ -z "$NPM_TOKEN" ]; then
  echo "ERROR: NPM_TOKEN environment variable is not set!"
  echo "Please set NPM_TOKEN before running this script."
  exit 1
fi

cat > "$RELEASE_DIR/.npmrc" << EOF
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=$NPM_TOKEN
EOF

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

# Step 8: Cleanup and success message
echo "=== CLI Release Created Successfully ==="
echo "Release location: $RELEASE_DIR"
echo ""
echo "To install locally:"
echo "  cd $RELEASE_DIR && npm install"
echo "  Note: Local install via 'npm install' does NOT make 'opendesk' globally accessible."
echo "  For global access, use one of the following:"
echo "    cd $RELEASE_DIR && npm link          # Create a global symlink (recommended for testing)"
echo "    npm install -g ./$RELEASE_DIR        # Install globally from local directory"
echo ""
echo "To publish to npm:"
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "  cd $RELEASE_DIR && npm publish --access public --tag nightly"
else
  echo "  cd $RELEASE_DIR && npm publish --access public"
fi
