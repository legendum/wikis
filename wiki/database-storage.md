# Database Storage

## Overview

The "wikis" project employs SQLite as its primary database backend through the Bun SQLite module, providing lightweight, file-based storage with zero-configuration setup, high portability, and seamless operation in both self-hosted and hosted environments. Databases persist user accounts, wiki metadata, generated wiki pages, source files, wiki chunks for search (leveraging FTS5 indexes and vector embeddings), usage events for billing and monitoring, and wiki update logs.

Data isolation occurs across multiple database files: the global database (`data/wikis.db`) manages cross-user registry and authentication; per-user databases (`data/user{id}.db`) handle private wikis and sources; the public database (`data/public.db`) stores shared public wikis. This design bolsters security by blocking cross-user data access, minimizes lock contention for improved concurrency, and facilitates horizontal scaling.

Databases operate in Write-Ahead Logging (WAL) mode to support concurrent reads and writes, with foreign keys enabled for referential integrity. FTS5 virtual tables enable rapid full-text search on wiki content via Porter stemming and Unicode61 tokenization. Vector embeddings, stored as BLOBs from Ollama models such as `all-minilm`, support semantic similarity ranking through cosine distance computations. These elements integrate with [authentication.md] for access control, [syncing-mechanism.md] for file synchronization, [search-features.md] for hybrid FTS+RAG queries, [ai-generation.md] for source-to-wiki mapping and regeneration, and [api-reference.md] for tool access.

## Global Database

The global database at `data/wikis.db` centralizes user management,