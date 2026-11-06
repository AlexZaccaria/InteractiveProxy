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

  // Linting is done by ESLint 9 from the workspace root (`npm run lint`);
  // CRA's bundled ESLint 8 plugin would pick up the hoisted ESLint 9 and fail
  // to load its legacy "react-app" config.
  process.env.DISABLE_ESLINT_PLUGIN = 'true';

  // Delegate directly to CRA's build script so the build runs with the
  // generated port configuration without needing an extra child process.
  // react-scripts is resolved from the client package so it works whether
  // npm hoisted it to the workspace root or kept it under client/node_modules.
  require(require.resolve('react-scripts/scripts/build', { paths: [clientDir] }));
}

main();
