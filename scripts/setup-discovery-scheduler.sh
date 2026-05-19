#!/usr/bin/env bash
# One-time setup: Cloud Scheduler job that triggers the lead-discovery
# Cloud Run Job daily at 02:00 CET. Run from your machine (gcloud + auth
# already in place — see DEPLOY.md). Idempotent.

set -euo pipefail

PROJECT_ID="vedio-444210"
REGION="europe-west1"
JOB_NAME="lead-discovery"
SCHEDULER_NAME="lead-discovery-daily"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
# Cloud Scheduler hits the Cloud Run Jobs API directly with an OIDC token.
# The runtime service account for Cloud Run Jobs (and the SA Scheduler uses
# to authenticate) is the project's default compute SA — same one the main
# service uses. Reuses existing IAM bindings (secret access + bucket).
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"

echo "==> Enabling Cloud Scheduler API"
gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID" --quiet >/dev/null

echo "==> Granting roles/run.invoker on the job to $RUNTIME_SA"
gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/run.invoker" \
  --quiet >/dev/null 2>&1 || echo "    (binding already exists or job not yet deployed)"

if gcloud scheduler jobs describe "$SCHEDULER_NAME" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> Updating existing scheduler job"
  gcloud scheduler jobs update http "$SCHEDULER_NAME" \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --schedule="0 1 * * *" \
    --time-zone="Europe/Copenhagen" \
    --uri="$JOB_RUN_URI" \
    --http-method=POST \
    --oauth-service-account-email="$RUNTIME_SA" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
    --description="Trigger lead-discovery Cloud Run Job daily 02:00 CET"
else
  echo "==> Creating scheduler job"
  gcloud scheduler jobs create http "$SCHEDULER_NAME" \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --schedule="0 1 * * *" \
    --time-zone="Europe/Copenhagen" \
    --uri="$JOB_RUN_URI" \
    --http-method=POST \
    --oauth-service-account-email="$RUNTIME_SA" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
    --description="Trigger lead-discovery Cloud Run Job daily 02:00 CET"
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "✅ Cloud Scheduler set up. The job fires daily 02:00 CET."
echo
echo "Manual trigger (smoke test):"
echo "  gcloud scheduler jobs run $SCHEDULER_NAME --location=$REGION --project=$PROJECT_ID"
echo
echo "Or run the Cloud Run Job directly:"
echo "  gcloud run jobs execute $JOB_NAME --region=$REGION --project=$PROJECT_ID"
echo
echo "Tail logs:"
echo "  gcloud beta run jobs executions logs read \\"
echo "    \$(gcloud run jobs executions list --job=$JOB_NAME --region=$REGION --limit=1 --format='value(name)') \\"
echo "    --region=$REGION --project=$PROJECT_ID"
echo "════════════════════════════════════════════════════════════"
