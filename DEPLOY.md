# Deployment — Google Cloud Run

Vedio Leads is deployed to **Cloud Run** in project `vedio-444210`, region `europe-west1`.
Data is persisted to GCS bucket `vedio-leads-data` (mounted as `/data`).
The Gemini API key lives in Secret Manager (`gemini-api-key`).
GitHub Actions builds and deploys on every push to `main`.

## First-time setup (run once)

1. Open Cloud Shell: <https://shell.cloud.google.com/?project=vedio-444210>
2. Clone the repo and run the setup script:
   ```bash
   git clone https://github.com/Vedio-dk/leads.git && cd leads
   bash scripts/gcp-setup.sh
   ```
   The script will prompt for the Gemini API key (input hidden).
3. Follow the on-screen "NEXT STEPS" — they tell you how to:
   - Upload `users.json` to the bucket (required for login)
   - Add `GCP_SA_KEY` as a GitHub secret
   - Delete the local key file

After that, every push to `main` auto-deploys via `.github/workflows/deploy.yml`.

## Manual redeploy

Push to `main`, or trigger the workflow from
<https://github.com/Vedio-dk/leads/actions/workflows/deploy.yml>.

## Updating the Gemini API key

```bash
echo -n NEW_KEY | gcloud secrets versions add gemini-api-key --data-file=-
gcloud run services update leads --region europe-west1 \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest
```

## Editing persisted data

The JSON files live in `gs://vedio-leads-data/`. To edit `users.json`:

```bash
gcloud storage cp gs://vedio-leads-data/users.json .
# edit locally
gcloud storage cp users.json gs://vedio-leads-data/users.json
```

Cloud Run reads the file on next request — no redeploy needed.

## Notes

- `max-instances: 1` to avoid write races on the single shared JSON files.
- The `.cache` directory is ephemeral per container — cache misses on cold start are fine.
- Don't commit `.env`, `users.json`, or `data*.json` — they're gitignored.
