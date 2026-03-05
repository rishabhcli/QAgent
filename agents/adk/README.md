# ADK/A2A Integration (Experimental)

**Status:** Planned, not yet integrated

This directory contains experimental wrapper code for integrating QAgent's agent pipeline with Google's Agent Development Kit (ADK) and Agent-to-Agent (A2A) protocol.

## Files

- `agents.ts` - Wraps existing QAgent agents (Tester, Triage, Fixer, Verifier) in an ADK-compatible interface
- `workflow.ts` - Declarative workflow engine that can execute agent steps in sequence with context threading

## Current State

These files are **not called** by the main orchestrator. The primary orchestration is handled by `agents/orchestrator/index.ts`.

## Prerequisites for Activation

1. Install Google ADK SDK
2. Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` environment variables
3. Wire `executeADKWorkflow()` into the orchestrator as an alternative execution mode
