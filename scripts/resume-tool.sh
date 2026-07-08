#!/usr/bin/env bash
# Resume the Vedio Leads tool after a pause.
#
# Reverses the pause done on 2026-07-08:
#   • Resumes all 22 Cloud Scheduler jobs
#   • Sets Cloud Run min-instances back to 1
#
# Data on GCS bucket (gs://vedio-leads-data) was untouched during
# the pause and remains ready — no restore step needed.
#
# BEFORE running this:
#   1. Reactivate your Apollo subscription (apollo.io)
#   2. Reactivate StoreLeads (storeleads.app)
#   3. Confirm Twenty CRM is active if you're pushing leads
#   4. Full Enrich / Apify / Gemini need no action — pay-per-use,
#      resume the moment the crons fire again
#
# Usage:  bash scripts/resume-tool.sh

set -e
REGION=europe-west1
SERVICE=leads

echo "═══ 1/2 Resuming Cloud Scheduler jobs ═══"
gcloud scheduler jobs list --location="$REGION" \
  --format='value(name.basename())' --filter='state=PAUSED' \
  | while read job; do
      [ -z "$job" ] && continue
      if gcloud scheduler jobs resume "$job" --location="$REGION" --quiet 2>/dev/null; then
        echo "  ✓ $job"
      else
        echo "  ✗ $job"
      fi
    done

echo ""
echo "═══ 2/2 Cloud Run min-instances → 1 ═══"
gcloud run services update "$SERVICE" --region="$REGION" \
  --min-instances=1 --quiet | tail -3

echo ""
echo "═══ State check ═══"
E=$(gcloud scheduler jobs list --location="$REGION" --filter='state=ENABLED' --format='value(name)' | wc -l | tr -d ' ')
P=$(gcloud scheduler jobs list --location="$REGION" --filter='state=PAUSED' --format='value(name)' | wc -l | tr -d ' ')
echo "  Scheduler — Enabled: $E   Paused: $P"
echo "  Cloud Run — $(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.latestReadyRevisionName)') serving 100%"
echo ""
echo "✅ Tool is live again. First cron fires per its schedule."
