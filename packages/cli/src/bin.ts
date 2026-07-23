#!/usr/bin/env node
import { createCli } from './cli.js';

createCli()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`QAgent error: ${message}\n`);
    if (!process.exitCode) process.exitCode = message.includes('API_KEY') ? 3 : 2;
  });
