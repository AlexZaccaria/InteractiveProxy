#!/usr/bin/env node

/**
 * Development launcher for the React client.
 *
 * - Reads ports.config.json in the project root.
 * - Generates client/src/config/generatedPorts.js.
 * - Sets process.env.PORT for CRA based on uiPort.
 * - Starts `npm start` inside the client directory.
 */

const path = require('path');
const { ROOT_DIR, loadPortsConfig, generateClientPortsModule } = require('./scripts/portsTools');

function main() {
  const { uiPort } = loadPortsConfig();

  const generatedTarget = path.join(ROOT_DIR, 'client', 'src', 'config', 'generatedPorts.js');
  generateClientPortsModule(generatedTarget);

  // Expose the UI port to Create React App via the standard PORT env var.
  process.env.PORT = String(uiPort);

  const clientDir = path.join(ROOT_DIR, 'client');
  process.chdir(clientDir);

  // Delegate directly to CRA's start script. This avoids cross-platform spawn
  // issues while still respecting the PORT env we just set.
  // eslint-disable-next-line import/no-dynamic-require, global-require
  require(path.join(clientDir, 'node_modules', 'react-scripts', 'scripts', 'start'));
}

main();
