#!/bin/bash
# Publish script for @night-cloud/cli
# 
# Usage:
#   1. Make sure you're logged in: npm login
#   2. Update version in packages/cli/package.json
#   3. Run: npm run publish (or ./publish.sh)
#
# This script will:
#   - Check npm login status
#   - Show current version
#   - Build the CLI package
#   - Publish to npm with public access
#
set -e

echo "🚀 Publishing Night Cloud Miner to npm"
echo "========================================"
echo ""

# Check if logged in to npm
if ! npm whoami &> /dev/null; then
  echo "❌ Not logged in to npm. Please run: npm login"
  exit 1
fi

echo "✅ Logged in to npm as: $(npm whoami)"
echo ""

# Show current version
CURRENT_VERSION=$(node -p "require('./packages/cli/package.json').version")
echo "📌 Current version: $CURRENT_VERSION"
echo ""
echo "💡 To bump version, edit packages/cli/package.json before running this script"
echo ""

# Confirm publish
read -p "📦 Ready to publish @night-cloud/cli v$CURRENT_VERSION? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Publish cancelled"
  exit 1
fi

echo ""
echo "📦 Building and publishing @night-cloud/cli..."
echo ""

# Navigate to CLI package
cd packages/cli

# Build (prepublishOnly will run automatically, but we'll do it explicitly for visibility)
echo "🔨 Building package..."
npm run build

echo ""
echo "📤 Publishing to npm..."
npm publish --access public

echo ""
echo "✅ Successfully published @night-cloud/cli!"
echo ""
echo "📋 You can now install it with:"
echo "   npm install -g @night-cloud/cli"
echo "   or"
echo "   npx @night-cloud/cli"

