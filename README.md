# Wedding Enquiry Tracker

A web app for logging and following up wedding enquiries. It replaces the "Tracked Wedding Conversion Summary" spreadsheet. It runs on **Cloudflare Workers**, and the data lives in a **Cloudflare D1** database.

## What it does

- **Add new enquiry**: one button opens a form with all the enquiry details. The first date field is pre-filled with today's date.
- **Enquiries list**: search, filter by stage and sort any column. You can change an enquiry's stage, and tick or untick checklist items, straight from the list.
- **Board**: drag enquiries between workflow stages (New enquiry → Responded → Tour booked → Toured → Booked / Lost).
- **Notes and history**: every change is logged with who made it and when. You can also add notes, such as a phone call or a follow-up.
- **Summary**: totals, conversion rate, average days to confirm, breakdowns by stage, by source and by any other dropdown, checklist progress, and enquiries per month.
- **Export CSV**: download the current list to open in Excel.
- **Accounts**:
  - *Wedding staff* can add, edit and update enquiries.
  - *Admins* can also delete enquiries and use **Admin settings**:
    - **Form fields**: add, rename, reorder or remove fields. Field types are tick box, dropdown, date, text, long text, number, email, phone, and "days between two dates" (calculated automatically). Removed fields keep their saved answers and can be restored.
    - **Workflow stages**: add, rename, recolour, reorder or delete stages, and mark which stages count as "booked" and "lost".
    - **Staff accounts**: create accounts, reset passwords, switch roles, and deactivate people who leave.
    - **General**: the venue or app name.

## First run

Open the deployed site. Because the database has no users yet, it asks you to create the **admin account**. After that, add staff from **Admin settings → Staff accounts**.

## Deploying (GitHub → Cloudflare)

The D1 database `wedding-enquiries` already exists and has its tables set up. Its id is in `wrangler.jsonc`.

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**. Pick this GitHub repo.
2. Leave the build command empty. The deploy command is `npx wrangler deploy`, which is the default.
3. Deploy. Every push to `main` then redeploys automatically.

To deploy from your own computer instead, run `npm install`, then `npx wrangler login`, then `npm run deploy`.

### Database changes

All the customisation (fields, stages, accounts) is stored as data, so day-to-day changes never need a database migration. If a developer later adds a file to `migrations/`, apply it with `npm run db:migrate`.

## Local development

```bash
npm install
npm run dev        # sets up a local database and serves http://localhost:8787
```

## Project layout

```
src/worker.js        API: auth, enquiries, admin (fields/stages/users)
public/              Frontend (plain HTML/CSS/JS, no build step)
migrations/          D1 schema and default fields and stages
wrangler.jsonc       Cloudflare config (Worker + static assets + D1 binding)
```

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (100k iterations). Sessions are random tokens, and the database stores only their hashes. The session cookie is HttpOnly, Secure and SameSite=Lax.
- After 5 wrong passwords, the account is locked for 15 minutes.
- Deactivating a user, changing their role or resetting their password signs them out everywhere.
