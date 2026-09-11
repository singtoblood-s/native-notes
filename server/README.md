# InkNote sync server

The service owns one persistent SQLite file. GitHub Pages only hosts the web
client; point the client's Settings field at this service's HTTPS URL.

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "8080"
$env:NOTES_DB_PATH = "data/inknote.db"
..\gradlew.bat :server:run
```

Configuration uses `HOST`, `PORT`, and `NOTES_DB_PATH`. `ALLOWED_ORIGINS` is a
comma separated list and defaults to
`https://singtoblood-s.github.io`; add `http://localhost:5173` for local Vite
development. Put the server behind HTTPS before using a real account. Keep
the database directory on persistent storage and back it up while the service
is stopped or with a SQLite consistent backup tool.

The Docker image is built from the repository root:

```sh
docker build -f server/Dockerfile -t inknote-server .
docker run --rm -p 8080:8080 -v inknote-data:/data inknote-server
```

Registration uses a username or email-like identifier and a 12–128 character
password. Passwords use PBKDF2-HMAC-SHA256 with a unique salt and 600,000
iterations; sessions are opaque, hashed at rest, expire after 30 days, and can
be revoked. There is no email recovery or OAuth provider in this first release.
