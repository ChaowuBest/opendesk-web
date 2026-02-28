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
    *)
      echo "ERROR: Unknown option $1"
      echo "Usage: $0 --stable|--nightly"
      exit 1
      ;;
  esac
done

# Validate that either --stable or --nightly is provided
if [ -z "$RELEASE_TYPE" ]; then
  echo "ERROR: You must specify either --stable or --nightly"
  echo "Usage: $0 --stable|--nightly"
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
  DATE=$(date +%Y%m%d)
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

echo "Creating Windows launch scripts..."

# Create .cmd file for Windows Command Prompt
cat > "$RELEASE_DIR/opendesk.cmd" << 'EOF'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "OPENDESK_FILE=%SCRIPT_DIR%opendesk"

REM Try to find node in PATH
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    node "%OPENDESK_FILE%" %*
    exit /b %ERRORLEVEL%
)

REM Try common node installation paths
if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" "%OPENDESK_FILE%" %*
    exit /b %ERRORLEVEL%
)

if exist "C:\Program Files (x86)\nodejs\node.exe" (
    "C:\Program Files (x86)\nodejs\node.exe" "%OPENDESK_FILE%" %*
    exit /b %ERRORLEVEL%
)

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%OPENDESK_FILE%" %*
    exit /b %ERRORLEVEL%
)

echo ERROR: node.exe not found in PATH or common installation locations
echo Please install Node.js from https://nodejs.org/
exit /b 1
EOF

# Create .ps1 file for PowerShell
cat > "$RELEASE_DIR/opendesk.ps1" << 'EOF'
$ErrorActionPreference = "Stop"

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmdScript = Join-Path $scriptPath "opendesk.cmd"

# Delegate to the .cmd script to avoid duplicate logic
& cmd.exe /c "`"$cmdScript`" $args"
exit $LASTEXITCODE
EOF

# Make scripts executable (for Git)
chmod +x "$RELEASE_DIR/opendesk.cmd"
chmod +x "$RELEASE_DIR/opendesk.ps1"

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
    "opendesk": "./opendesk",
    "opendesk.cmd": "./opendesk.cmd",
    "opendesk.ps1": "./opendesk.ps1"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "number-to-alphabet": "^1.0.0",
    "vectra": "^0.11.1"
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

# Step 7: Cleanup and success message
echo "=== CLI Release Created Successfully ==="
echo "Release location: $RELEASE_DIR"
echo ""
echo "To install locally:"
echo "  cd $RELEASE_DIR && npm install"
echo ""
echo "To publish to npm:"
if [ "$RELEASE_TYPE" = "nightly" ]; then
  echo "  cd $RELEASE_DIR && npm publish --access public --tag nightly"
else
  echo "  cd $RELEASE_DIR && npm publish --access public"
fi
