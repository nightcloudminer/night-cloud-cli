#!/usr/bin/env node

/**
 * Package the miner into a tarball and copy it to the CLI dist folder
 * This allows the CLI to be distributed with the miner code included
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '../../..');
const minerDir = path.join(projectRoot, 'packages/miner');
const cliDistDir = path.join(projectRoot, 'packages/cli/dist');
const tempDir = path.join(projectRoot, '.tmp-miner-package');
const tempMinerDir = path.join(tempDir, 'miner');
const tarballPath = path.join(cliDistDir, 'miner-code.tar.gz');

console.log('📦 Packaging miner code...');

// Check if miner directory exists
if (!fs.existsSync(minerDir)) {
  console.error('❌ Miner directory not found at:', minerDir);
  process.exit(1);
}

// Check if miner is built
if (!fs.existsSync(path.join(minerDir, 'dist/cli.js'))) {
  console.error('❌ Miner not built. Please run "npm run build" in packages/miner first.');
  process.exit(1);
}

try {
  // Clean up any existing temp directory
  if (fs.existsSync(tempDir)) {
    console.log('  Cleaning up old temp directory...');
    execSync(`rm -rf ${tempDir}`, { stdio: 'pipe' });
  }

  // Create temp directory structure
  console.log('  Creating package structure...');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(tempMinerDir, { recursive: true });
  fs.mkdirSync(path.join(tempMinerDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(tempMinerDir, 'dist/scripts'), { recursive: true });

  // Copy bundled JS files
  console.log('  Copying bundled JavaScript files...');
  execSync(`cp ${path.join(minerDir, 'dist/cli.js')} ${tempMinerDir}/dist/`, { stdio: 'pipe' });
  execSync(`cp ${path.join(minerDir, 'dist/scripts/assign-addresses.js')} ${tempMinerDir}/dist/scripts/`, { stdio: 'pipe' });
  execSync(`cp ${path.join(minerDir, 'dist/scripts/heartbeat.js')} ${tempMinerDir}/dist/scripts/`, { stdio: 'pipe' });
  execSync(`cp ${path.join(minerDir, 'dist/scripts/cleanup-registry.js')} ${tempMinerDir}/dist/scripts/`, { stdio: 'pipe' });

  // Copy Rust source code (will be compiled on the instance)
  console.log('  Copying Rust source code...');
  execSync(`cp -r ${path.join(minerDir, 'rust')} ${tempMinerDir}/`, { stdio: 'pipe' });
  
  // Remove ALL build artifacts to save space (including nested target directories)
  console.log('  Removing build artifacts...');
  execSync(`find ${tempMinerDir}/rust -type d -name "target" -exec rm -rf {} + 2>/dev/null || true`, { stdio: 'pipe' });

  // Copy package.json
  console.log('  Copying package.json...');
  execSync(`cp ${path.join(minerDir, 'package.json')} ${tempMinerDir}/`, { stdio: 'pipe' });

  // Create tarball
  console.log('  Creating tarball...');
  execSync(`tar -czf ${tarballPath} -C ${tempDir} miner`, { stdio: 'pipe' });

  // Clean up temp directory
  console.log('  Cleaning up...');
  execSync(`rm -rf ${tempDir}`, { stdio: 'pipe' });

  // Get tarball size
  const stats = fs.statSync(tarballPath);
  const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`✅ Miner packaged successfully!`);
  console.log(`   Location: ${path.relative(projectRoot, tarballPath)}`);
  console.log(`   Size: ${sizeInMB} MB`);

} catch (error) {
  console.error('❌ Failed to package miner:', error.message);
  
  // Clean up on error
  if (fs.existsSync(tempDir)) {
    execSync(`rm -rf ${tempDir}`, { stdio: 'pipe' });
  }
  
  process.exit(1);
}

