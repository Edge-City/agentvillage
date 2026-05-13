# EdgeClaw Skills

This directory contains backend-specific skill files for EdgeClaw agents.

Each backend folder should explain:

- what the backend is responsible for
- which credential the agent needs
- which endpoints or tools to use
- what the agent must confirm with the human before taking action
- what data is public, private, masked, or source-of-truth

Public skill files are safe to read. The credentials that unlock the backends are not stored here and must be injected by EdgeOS, InstaClaw, or the user's own runtime.
