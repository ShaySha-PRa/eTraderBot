# Startup and data preservation

## 日常启动和恢复

`pnpm dev` retains existing branch databases and their files. If a configured database cannot be reached, startup stops without silently selecting a different database. For an explicitly selected dataset, configure its database URLs and matching absolute `DATA_DIR`, then run `pnpm dev --existing`.

Before restoring, back up the database, its files, and the matching encryption configuration. Restore into a separate database and directory, verify records and attachments, then explicitly select that dataset. Startup does not remove existing databases or files.
