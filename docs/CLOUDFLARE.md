# Cloudflare Worker and D1 migration

This is a one-time migration from the JVM server's SQLite file to the D1
database used by the Worker. The exporter writes a consistent SQLite backup and
a data-only SQL file under `.local/d1-export/`. The directory is gitignored and
must be treated as private: the SQL contains note payloads, user identifiers,
password salts and password hashes.

The exporter uses only Python's standard library. Run its synthetic check first:

```powershell
python .\scripts\export-d1.py --self-test
```

Stop the old backend before the final export if edits must not land after the
snapshot. A read-only SQLite connection and `sqlite3.backup()` make the backup
and SQL come from one consistent snapshot. Start with a dry run; it does not
create files or print rows:

```powershell
python .\scripts\export-d1.py --database .\.local\notes.db --dry-run
python .\scripts\export-d1.py --database .\.local\notes.db
```

The normal run creates these private files:

```text
.local/d1-export/d1-backup.sqlite3
.local/d1-export/d1-data.sql
.local/d1-export/d1-manifest.json
```

Use `--force` to deliberately replace those files. The SQL contains inserts in
foreign-key order for `users`, `documents`, `changes`, and `sync_operations`.
It contains no DDL and no `BEGIN`/`COMMIT`; apply the Worker schema first. A
text value that would make one statement larger than the D1 limit is inserted
as an empty value followed by keyed `UPDATE` chunks. The default statement
budget is 32,000 UTF-8 bytes, below D1's hard 100,000-byte limit.

## Create and populate D1

This repository already has the `native-notes` D1 database configured in
`cloudflare/wrangler.toml` with database ID
`2f83358e-6bfd-4fe4-ad2b-688bd4eb577c`. Do not run `d1 create` for this
migration. The schema is `cloudflare/migrations/0001_initial.sql`. Run the
following commands from `cloudflare/`, applying that migration before the data
file:

```powershell
Push-Location .\cloudflare
npx wrangler login
npx wrangler d1 migrations apply native-notes --remote
npx wrangler d1 execute native-notes --remote --file=..\.local\d1-export\d1-data.sql --yes
```

The target should be a new, empty D1 database. If a non-empty database must be
reused, stop and compare its schema and account ownership first; this data file
does not merge accounts or reconcile existing rows. Do not blindly rerun a
partially applied file because a chunked row starts with an empty payload and
then appends its chunks.

Check counts and sequence state without returning note or credential values:

```powershell
npx wrangler d1 execute native-notes --remote --command="SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM changes) AS changes, (SELECT COUNT(*) FROM sync_operations) AS sync_operations, (SELECT COALESCE(MAX(sequence), 0) FROM changes) AS changes_max_sequence, (SELECT COUNT(*) FROM sessions) AS sessions;"
npx wrangler d1 execute native-notes --remote --command="PRAGMA quick_check;"
Pop-Location
```

Compare these values with `d1-manifest.json`. `sessions` should be zero for a
fresh import. The exporter preserves user UUIDs, PBKDF2 salt/hash fields,
document revisions, explicit change sequences, operation IDs, and request
fingerprints. It intentionally omits `sessions`: old session tokens are tied to
the previous endpoint in the client, and importing token hashes would extend
old credentials into a new public service. Users retain their accounts and
passwords, then sign in again to issue fresh sessions.

## Deploy a stable backend

After the schema, data, and API checks pass, deploy the Worker from
`cloudflare/`:

```powershell
Push-Location .\cloudflare
npx wrangler deploy
Pop-Location
```

Keep the Pages build variable `VITE_LEGACY_API_URL` set to the exact old
endpoint `https://nascar-essay-what-josh.trycloudflare.com` on every build
during this cutover. `webApp/src/auth.ts` uses that explicit value to map the
canonical account key back to the old local SQLite/IndexedDB namespace, so
removing or changing it later would make existing unsynced browser data appear
under a new namespace. Keep it until an explicit physical namespace migration
is implemented. Set `VITE_API_URL` to the new stable Worker URL only after the
D1 import and live API checks pass; `VITE_LEGACY_API_URL` is a local namespace
compatibility flag, not the endpoint used for new requests.

Use the resulting named `workers.dev` URL or a stable HTTPS custom domain as
the app's server URL. Configure the Worker CORS allowlist for the deployed web
app origin before sign-in. A quick tunnel URL is temporary and changes when the
tunnel restarts; changing endpoints creates a separate client workspace and
requires login again. Keep the old JVM backend available until the new URL has
passed register/login, logout, push, pull, account-isolation, and conflict
checks.

The Worker must preserve the v1 API in `docs/CONTRACT.md`. Existing credentials
use PBKDF2-HMAC-SHA256 with 600,000 iterations, a 16-byte URL-safe base64 salt
without padding, and a 256-bit URL-safe base64 hash without padding. The D1
auth implementation must verify exactly that representation; it must never
replace the hash with a plaintext password or log a password. Use a synthetic
credential fixture to test compatibility before asking real users to sign in.

`sync_operations.request_hash` is the SHA-256 fingerprint of the compact v1
operation JSON. Imported retries from this repository's web client remain
compatible because both sides use the web client's `JSON.stringify` form. The
legacy Kotlin JSON tree preserves the original spelling of payload numbers;
raw clients that send equivalent spellings such as `1024.0` or `1e3` can be
normalized differently by the Worker and receive `idempotency_mismatch`.
Keep web serialization unchanged during migration, or define a shared numeric
canonicalization before supporting other clients.

## Limits and free-plan constraints

Cloudflare currently documents these D1 limits: 100,000 bytes per SQL
statement, 100 bound parameters per query, 2,000,000 bytes per string/BLOB or
table row, and a 5 GB maximum `d1 execute --file` import. The exporter keeps
each generated statement under 32,000 bytes and uses no bound parameters in the
file. The source server accepts payloads up to 2 MiB (2,097,152 bytes), which
is larger than D1's row ceiling. The exporter therefore stops before writing
the bundle when its conservative row estimate leaves less than a small safety
margin below 2,000,000 bytes; SQL chunking cannot bypass the D1 row limit. Move
such payloads to a separately designed object store or reduce the source
payload before migrating.

See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
and [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/)
for current platform behavior.

The Workers Free plan currently allows 100,000 Worker requests per day, 10 ms
CPU time per request, 128 MB memory, and 50 subrequests per invocation. This
Worker forwards requests to the SQLite-backed `ApiDurableObject`: the outer
Worker still has its 10 ms budget, while a Durable Object invocation has a
30-second default CPU budget. D1's free allowance is suitable for a small
personal service but has finite daily read/write quotas and a 500 MB
per-database storage limit. A public free-plan endpoint still needs HTTPS, rate
limiting, CORS restrictions, backups, and an account recovery plan; this v1 API
has no email recovery and is not end-to-end encrypted.

See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
before exposing the endpoint to more users.
