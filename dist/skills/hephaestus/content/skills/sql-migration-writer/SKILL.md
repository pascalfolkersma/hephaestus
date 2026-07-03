---
name: sql-migration-writer
description: "Use when writing or reviewing SQL schema migrations for a relational database (Postgres, MySQL, SQLite, etc.) — new tables, columns, indexes, or data backfills. Triggers: 'write a migration', 'add a column', 'create the migration file', 'add an index', 'this migration needs a down', 'is this migration safe to run'."
---

# SQL Migration Writer

Conventions for authoring reversible, safe-by-default SQL schema migrations in backend and data-pipeline projects. Applies regardless of migration tool (Knex, Flyway, Alembic-style raw SQL, node-pg-migrate, Prisma migrate, etc.) — the underlying SQL discipline is the same; adapt the file wrapper to whatever the project already uses.

## Naming convention

- File name: `<sortable-timestamp>_<verb>_<description>.sql` (or the equivalent two-file up/down pair the project's tool expects), e.g. `20260703142200_add_index_users_email.sql`.
- Timestamp prefix is sortable (UTC, `YYYYMMDDHHMMSS` or the project tool's native format) so migrations apply in creation order across branches.
- Description starts with a verb: `create`, `add`, `drop`, `rename`, `backfill`, `alter`. One migration, one intent — don't bundle an unrelated column add into a migration that's really about an index.
- Never edit a migration file that has already been applied to any shared environment (staging, production). Write a new migration to correct it instead — migrations are an append-only log of what actually happened to the schema.

## Reversible up/down structure

Every migration ships both directions unless the change is provably irreversible (e.g. a destructive data backfill with no source of truth to rebuild from — and even then, document why in a comment rather than silently omitting `down`).

```sql
-- up
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'light',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- down
DROP TABLE IF EXISTS user_preferences;
```

- `down` must be the true inverse of `up` — it should leave the schema exactly as it was before `up` ran; re-applying `up` after `down` should be a repeatable no-op-safe cycle.
- For destructive `up` operations (`DROP COLUMN`, `DROP TABLE`, data deletion), the `down` cannot restore lost data — state that explicitly in a comment above the `down` block so a rollback decision is made with full information, not by assuming symmetry.

## Idempotency guards

Every DDL statement guards against re-running on a schema that's already partially migrated (deploy retries, manually-applied hotfixes, out-of-order environments):

- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (Postgres 9.6+; for engines without `IF NOT EXISTS` on `ADD COLUMN`, check `information_schema.columns` first, or rely on the migration tool's own dirty-state tracking and skip the guard)
- `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for constraints/types on engines without a native `IF NOT EXISTS` clause for that object kind
- Never assume a migration runner's own bookkeeping table is the only thing preventing double-application — guards make the SQL itself safe to hand-run twice.

## Safe-by-default patterns

- **Avoid long-held locks on large tables.** `ALTER TABLE ... ADD COLUMN` with a non-null default rewrites every row on older Postgres versions (<11) and MySQL without `ALGORITHM=INSTANT` — prefer adding the column nullable first, backfilling in batches, then adding the `NOT NULL` constraint in a follow-up migration once backfill is complete.
- **Add indexes concurrently where the engine supports it** (`CREATE INDEX CONCURRENTLY` on Postgres) to avoid blocking writes on the target table. Concurrent index creation cannot run inside a transaction block — check the migration tool wraps it correctly or opts the migration out of its default transaction wrapper.
- **Never `DROP COLUMN` or `DROP TABLE` in the same release that stops using it.** Deploy the code change that stops reading/writing the column first, verify in production, then ship the drop as a separate, later migration — this keeps rollback of the code deploy safe without a schema mismatch.
- **Batch large backfills.** Update in bounded chunks (`WHERE id BETWEEN ... LIMIT n`, looped) rather than a single unbounded `UPDATE` — avoids long transactions, replication lag, and lock contention on high-traffic tables.
- **Foreign keys and constraints**: add as `NOT VALID` (Postgres) first, then `VALIDATE CONSTRAINT` in a follow-up step, to avoid a full-table validation scan inside the blocking migration transaction.
- **Never generate a migration that silently truncates or casts data with loss** (e.g. narrowing a column type) without an explicit, reviewed data-safety note in the migration file comment.

## Conventions summary

- One logical change per migration file.
- Guard every DDL statement for idempotency.
- Write `down` as a true inverse; document explicitly when it can't be.
- Split add-column-not-null and drop-column changes across separate, sequenced migrations to keep deploys and rollbacks safe.
- Prefer concurrent/non-locking variants of index and constraint operations on any table with production write traffic.
