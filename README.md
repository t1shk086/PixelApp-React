# PixelApp — React migration, stage 1

A **first working migration slice**, NOT full Streamlit feature parity.

## Preserved existing data

The existing Google Drive folder `PixelApp_Data` and original 2026 CSV filenames/schemas remain in place. The first explicit sync **downloads CSV files** from Drive; it does not delete anything or touch `Photos/`. After a data edit, the API writes the corresponding CSV back to the *same* Drive file. Take a Google Drive copy/backup before edits or migration. Note: this is single-user only; do not edit the old Streamlit app and React app simultaneously because both write the same CSV documents and may overwrite each other's changes.

## Available in this starter

- React mobile-friendly dark UI
- Trips listing and creating trips (including duplicate destination IDs)
- Expense records and new expense entry
- Global-budget edit and compatible budget summaries
- Task list, toggle, add, delete
- Read-only Leaflet map with existing CSV points
- Google Drive import / write-back through server-side Python API

## Not ported yet

- Fuel analytics, odometer management, trip status and unlocking, all budget calculations/edits, complete travel comparison reports
- Photo gallery and upload/download (photos remain safe in existing Google Drive)
- Editable routes, favourite locations, location search, point labels, route ordering
- Category management, interface labels, full mobile swipe interactions and all remaining Streamlit workflows

## Run locally

Requirements: Python 3.10+ and Node 18+.

### API

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # on Windows, use copy
# edit backend/.env and give PIXELAPP_API_KEY a long random value
uvicorn main:app --reload --port 8000
```

If using Google Drive: copy `auth.client_id`, `auth.client_secret` and `google_drive.refresh_token` **privately from the old Streamlit Secrets** into the corresponding environment variables. Never copy these tokens into GitHub, React, messages, or browser local storage. This server uses the *existing* refresh token; it does not trigger a new OAuth grant. If the credentials no longer work, reauthorization will need to be handled separately.

### React

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173, enter your personal API key and click **Зареди от Google Drive** once. Without Drive credentials, you may use local data in backend/data/ for experiments.

## Before putting on the public internet

**The API key login is a development-only access gate, not a production account system.** For internet hosting configure HTTPS, real single-user authentication (e.g. an identity-aware access proxy), secure secret storage, strict CORS, backups and private hosting for the API. Never put `PIXELAPP_API_KEY`, Google tokens or Client Secret into a `VITE_` variable. Serving the React files alone (e.g. via Vercel) is not enough: the Python API must also be online. Free hosting options and limits change; check at deployment time.

## Important compatibility limitation

This first version intentionally does not add GPS/geocoding or auto-create a center point when a trip is created. It does not delete/rename existing trips or photos. Additional modules must be validated against existing sample CSV data before production migration.
