#!/usr/bin/env node

import { loadEnvironmentFiles } from './config/loadEnv.js';
import { CLI } from './cli/CLI.js';

async function main() {
  loadEnvironmentFiles();
  const cli = new CLI();
  await cli.start();
}

main().catch(console.error);
