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

  // Linting is done by ESLint 9 from the workspace root (`npm run lint`);
  // CRA's bundled ESLint 8 plugin would pick up the hoisted ESLint 9 and fail
  // to load its legacy "react-app" config.
  process.env.DISABLE_ESLINT_PLUGIN = 'true';

  // Delegate directly to CRA's start script. This avoids cross-platform spawn
  // issues while still respecting the PORT env we just set. react-scripts is
  // resolved from the client package so it works whether npm hoisted it to
  // the workspace root or kept it under client/node_modules.
  require(require.resolve('react-scripts/scripts/start', { paths: [clientDir] }));
}

main();
