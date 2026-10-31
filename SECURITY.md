# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Email **security@paperboyseo.com** with the subject "Paperboy security".
- Or use GitHub private vulnerability reporting: the "Report a vulnerability" button on the Security tab of this repository.

Include what you found, how to reproduce it, and the version or commit. You will get an answer within 3 business days. Please give us a reasonable window to fix it before you publish details. We credit reporters who want credit.

## Supported versions

This is a 0.x project. Only the latest release and the default branch get fixes.

## What is in scope

- The API server, worker, CLI and database migrations in this repository.
- The Docker setup (`Dockerfile`, `docker-compose.yml`).

Out of scope: the hosted product at paperboyseo.com (report it through the same channels and we will route it), and vulnerabilities in third-party services you connect.

## Handling secrets

- The server keeps API keys as SHA-256 hashes. A key is shown once, at creation.
- Search Console is read-only: the only OAuth scope requested is `webmasters.readonly`. Revoke it any time at myaccount.google.com/permissions.
- CMS credentials (WordPress, Ghost, webhooks) are stored in the `site_secrets` table, which has row-level security on and no client policies.
- The CLI stores its key in `~/.config/paperboy/config.json` with mode 0600.
- If a key leaks, delete it and create a new one. Rotate `APP_SECRET`, `POSTGRES_PASSWORD` and `PAPERBOY_DB_PASSWORD` if your `.env` leaks.
