#!/usr/bin/env node

/**
 * Build launcher for the React client.
 *
 * - Reads ports.config.json in the project root.
 * - Generates client/src/config/generatedPorts.js.
 * - Runs `npm run build` inside the client directory.
 */

const path = require('path');
const { ROOT_DIR, generateClientPortsModule } = require('./scripts/portsTools');

function main() {
  const generatedTarget = path.join(ROOT_DIR, 'client', 'src', 'config', 'generatedPorts.js');
  generateClientPortsModule(generatedTarget);

  const clientDir = path.join(ROOT_DIR, 'client');
  process.chdir(clientDir);

  // Delegate directly to CRA's build script so the build runs with the
  // generated port configuration without needing an extra child process.
  // eslint-disable-next-line import/no-dynamic-require, global-require
  require(path.join(clientDir, 'node_modules', 'react-scripts', 'scripts', 'build'));
}

main();
