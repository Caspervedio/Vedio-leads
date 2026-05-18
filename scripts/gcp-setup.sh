#!/usr/bin/env bash
# One-time setup for deploying Vedio Leads to Cloud Run.
# Run this in Google Cloud Shell (https://shell.cloud.google.com/?project=vedio-444210).
#
# What it does:
#   1. Enables required GCP APIs
#   2. Creates a GCS bucket for persistent JSON data
#   3. Creates an Artifact Registry repo for the container image
#   4. Stores the Gemini API key in Secret Manager
#   5. Creates a deploy service account and grants it the right roles
#   6. Outputs the SA JSON key — paste into GitHub Secrets as GCP_SA_KEY
#
# Usage: bash scripts/gcp-setup.sh

set -euo pipefail

PROJECT_ID="vedio-444210"
REGION="europe-west1"
BUCKET="vedio-leads-data"
REPO="leads"
SA_NAME="leads-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET_NAME="gemini-api-key"

echo "==> Setting project"
gcloud config set project "$PROJECT_ID"

echo "==> Enabling required APIs (one-time, may take ~1 min)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com

echo "==> Creating GCS bucket: gs://$BUCKET (region $REGION)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access
else
  echo "    bucket already exists, skipping"
fi

echo "==> Creating Artifact Registry repo: $REPO"
if ! gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Vedio Leads container images"
else
  echo "    repo already exists, skipping"
fi

echo "==> Storing Gemini API key in Secret Manager"
if ! gcloud secrets describe "$SECRET_NAME" >/dev/null 2>&1; then
  read -r -s -p "Paste Gemini API key (input hidden), then Enter: " GEMINI_KEY
  echo
  printf "%s" "$GEMINI_KEY" | gcloud secrets create "$SECRET_NAME" --data-file=-
else
  echo "    secret already exists. To update: echo -n NEW_KEY | gcloud secrets versions add $SECRET_NAME --data-file=-"
fi

echo "==> Creating deploy service account: $SA_EMAIL"
if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Vedio Leads GitHub Actions deployer"
else
  echo "    SA already exists, skipping"
fi

echo "==> Granting roles to deploy SA"
for ROLE in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/cloudbuild.builds.editor \
  roles/storage.admin \
  roles/secretmanager.secretAccessor \
  roles/iam.serviceAccountUser \
  roles/logging.logWriter
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE" \
    --condition=None \
    --quiet >/dev/null
done

echo "==> Granting Cloud Run runtime SA access to the secret and the bucket"
RUNTIME_SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/storage.objectAdmin" \
  --quiet >/dev/null

echo "==> Generating SA JSON key (save as GitHub secret GCP_SA_KEY)"
KEY_FILE="$HOME/leads-deployer-key.json"
gcloud iam service-accounts keys create "$KEY_FILE" \
  --iam-account="$SA_EMAIL"

echo
echo "════════════════════════════════════════════════════════════"
echo "✅ Setup complete."
echo
echo "NEXT STEPS:"
echo
echo "1. Upload your local users.json to the bucket so login works:"
echo "   gcloud storage cp users.json gs://$BUCKET/users.json"
echo "   (Drag-drop users.json into Cloud Shell first, or upload via the bucket UI.)"
echo
echo "2. Copy the contents of $KEY_FILE and add as a GitHub secret:"
echo "   Repo: https://github.com/Caspervedio/Vedio-leads"
echo "   Settings → Secrets and variables → Actions → New repository secret"
echo "   Name: GCP_SA_KEY"
echo "   Value: <paste the entire JSON below>"
echo
echo "─── BEGIN GCP_SA_KEY ──────────────────────────────────────"
cat "$KEY_FILE"
echo
echo "─── END GCP_SA_KEY ────────────────────────────────────────"
echo
echo "3. After the secret is set, push a commit (or re-run the workflow"
echo "   manually) to trigger deploy:"
echo "     https://github.com/Caspervedio/Vedio-leads/actions"
echo
echo "4. ⚠️  Delete the local key file once stored in GitHub:"
echo "     shred -u $KEY_FILE   # or: rm $KEY_FILE"
echo "════════════════════════════════════════════════════════════"
