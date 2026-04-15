# CLI Commands

## Overview

The "wikis" project provides a command-line interface (CLI) for managing personal AI-generated wikis. This CLI serves as the primary tool for initializing, maintaining, and interacting with wikis in a project directory. It operates as a background daemon that watches source files for changes via Git diffs (when available) or content hashing, pushes changes to a remote server or local instance via the `/api/sources` endpoint for LLM-based wiki regeneration, and performs bi-directional syncs of the local `wiki/` folder. The design emphasizes local-first operations, where wiki content resides in a local `wiki/` folder and syncs explicitly to preserve privacy and user control. A single daemon manages all registered projects machine-wide, applying exponential backoff (starting at 5 minutes, capping at 30 minutes per project) to optimize resource usage. Commands integrate with Git for change detection and support self-hosting.

The CLI runs on Bun for fast execution and straightforward installation. Per-project configuration resides in `wiki/config.yml` (defining sources and exclusions), while global settings like the Legendum account key and API URL appear in `~/.config/wikis/config.yml`. See [Configuration](configuration.md). Registered projects store in `~/.config/wikis/projects.yml`, tracking paths, names, and last check times. Example `projects.yml`:

```yaml
projects:
  - path: /Volumes/Code/wikis
    name: wikis
    last_check: 2026-04-04T12:00:00Z