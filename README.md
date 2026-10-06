# SLIET Notes Portal — Professional Edition

A professional college notes-management portal branded for **Sant Longowal Institute of Engineering & Technology (SLIET), Longowal**.

## What's new

- SLIET-branded academic portal interface
- College-style sidebar and header
- Semester-wise note organization
- Subject catalogue and subject cards
- Branch/semester profile fields
- Search by title, subject, uploader
- PDF/image preview
- Admin dashboard
- Production PostgreSQL support
- Supabase Storage support for cloud files
- Local SQLite/local uploads remain available for development
- Private cloud bucket architecture

## Production architecture

**PostgreSQL:** Supabase Postgres

**File storage:** Supabase Storage (`notes` bucket)

**Application:** Node.js + Express

**Email:** SMTP / Gmail App Password

The recommended production setup keeps file binaries outside PostgreSQL. Supabase Storage is designed for files and integrates with Postgres access policies. See the official docs:
- https://supabase.com/docs/guides/storage/quickstart
- https://supabase.com/docs/reference/javascript/file-buckets-upload

## Local development

1. Install Node.js 20 LTS or newer. On Windows, Node.js 20 LTS is recommended for the smoothest native SQLite installation.
2. Run:

   npm install

3. Copy `.env.example` to `.env`.
4. Leave `DATABASE_URL` blank for local SQLite.
5. Leave Supabase variables blank for local disk storage.
6. SMTP is optional for free development mode. Without SMTP, the OTP appears in the app and terminal.
7. Start:

   npm start

8. Open `http://localhost:3000`.

### Optional real email OTP delivery

For real email delivery, configure SMTP. For Gmail:

1. Enable 2-Step Verification on the sending Gmail account.
2. Create a Google App Password (do not use the normal Gmail password).
3. Put these values in `.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-account@gmail.com
SMTP_PASS=your-16-character-app-password
MAIL_FROM="SLIET Notes Portal <your-account@gmail.com>"
```

Restart the server after changing `.env`:

```powershell
npm start
```

If SMTP is not configured, the free development mode generates and displays an OTP locally.

## Production setup

### 1. Supabase project

Create a Supabase project.

### 2. Database

Open Supabase SQL Editor and run:

`supabase/schema.sql`

### 3. Storage

Create a **private** bucket named:

`notes`

Do not put the service role key in browser JavaScript.

### 4. Environment variables

Set:

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=notes`
- SMTP variables
- `SESSION_SECRET`
- admin credentials

When `DATABASE_URL` is present, the app uses PostgreSQL. When it is absent, it uses SQLite.

When Supabase variables are present, uploads are stored in the cloud bucket. Otherwise they are stored in `uploads/`.

### 5. Deployment

The app can be deployed to a Node-compatible host such as Render, Railway, Fly.io, or a VPS.

For production:
- use HTTPS
- use a strong random session secret
- keep Supabase service role key server-side
- use a private Storage bucket
- use signed URLs for highly sensitive material
- add rate limiting and malware scanning before public launch
- use a persistent session store instead of the default in-memory Express session

## Important note about the SLIET branding

The project uses the SLIET name and a clean SLIET monogram in the interface. For an official institutional deployment, replace the monogram asset with the institute-approved logo from the official SLIET logo/download page and follow the institute's branding permissions.

## Main files

- `server.js` — application backend
- `public/index.html` — portal UI
- `public/styles.css` — professional UI
- `public/app.js` — frontend logic
- `supabase/schema.sql` — PostgreSQL schema
- `.env.example` — configuration template

## Collaboration and faculty features

Notes support categories, tags, visibility (`Only me`, `Classmates`, or `All students`),
favorites, reminders, archive/restore, sharing with view/edit permission, and version
history storage. Administrators can assign `student`, `faculty`, or `admin` roles from
the Students screen. Faculty accounts receive a separate dashboard with note-category,
storage, downloads, and user-activity statistics. The local SQLite database also keeps
backup metadata; production deployments should schedule encrypted database and Storage
backups through the hosting provider.
