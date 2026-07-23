#!/usr/bin/env node
import { startMcpServer } from './server.js';

startMcpServer().catch((error: unknown) => {
  process.stderr.write(
    `QAgent MCP failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
