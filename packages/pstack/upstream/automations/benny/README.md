# Benny

Two T3 scheduled workflows handle Slack issue reports. Triage reads the source thread, investigates and deduplicates, then posts a trusted marker and optional tracker issue. Reproduction waits for that marker, proves the symptom on the real surface, and may prepare a bounded draft fix.

Point the agent at [FOR_AGENTS.md](./FOR_AGENTS.md) and name the repository. Setup copies the pack into `.agents/automations/benny/` while preserving local edits. Configuration, feature maps, routing, and secrets stay outside the copied pack. Read [setup-benny](./skills/setup-benny/SKILL.md) for installation, integration checks, test-channel validation, and schedule lifecycle.

A Slack event relay can send signed events to T3 webhook tasks when T3 Connect remote access is enabled. An explicitly chosen interval may read Slack through MCP instead. T3 supplies no automatic Slack subscription or persistent routine memory. Both workflows fail closed on missing thread coordinates, untrusted markers, or missing verification capabilities. Only the configured thread may receive a reply; workers cannot post to Slack.
