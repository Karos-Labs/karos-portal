# Wiring the follower sync to Cloud Scheduler

**What this is for.** `/api/followers/sync` (SCRUM-495) is the first and only thing that
ever writes a follower count in this system. The route exists and is deployed; nothing
calls it. Until a scheduler job exists, `clientFollowerSnapshots` stays empty, the audience
KPI stays hidden, and the performance third of the learning loop keeps contributing
nothing.

This is a one-time setup. Ten minutes, one `gcloud` command.

**Cost.** Cloud Scheduler bills per job, not per run: the first **3 jobs per billing
account per month are free**, and beyond that it is **$0.10 per job per 31 days**. So this
is somewhere between free and ten cents a month. Paused jobs still count as billable, so
delete rather than pause if you ever want it gone.

---

## Before you start

You need three things. Steps 1 and 2 get you two of them; the third is that you are logged
in as someone with `roles/cloudscheduler.admin` and `roles/secretmanager.secretAccessor`
on the production project.

> **Production only.** `DEPLOY_ENVIRONMENTS.md` is explicit that no Cloud Scheduler job may
> point at prep, and it matters more here than elsewhere: prep and production **share one
> Firestore**, so a prep job would be writing to the same `clientFollowerSnapshots`
> collection the production job writes to, against the same client ids. Prep's
> `CRON_SECRET` exists only so these routes answer 401 instead of 503. Do not create a
> second job against the prep URL.

Set these once in the shell you are about to use:

```bash
PROD_PROJECT_ID=karoscmo          # the production project — NOT karoscmo-prep
REGION=europe-west1               # where the service actually runs, checked 2026-09-18
SERVICE=karos-cmo
```

> **The region was wrong in this file until 2026-09-18** and it said `us-central1`, which
> is not a region this project has anything in. Step 1 then answers
> `ERROR: Cannot find service [karos-cmo]` — which reads like the service name is wrong,
> so the natural next move is to go hunting for the wrong thing. Everything in `karoscmo`
> is in **europe-west1**: `karos-cmo`, `agent-middleware`, `agent-engine-prod`,
> `agent-engine-prod-worker` and `landing-page`. If step 1 ever fails again, list them
> rather than guessing:
>
> ```bash
> gcloud run services list --project="$PROD_PROJECT_ID" --format='value(REGION,metadata.name,status.url)'
> ```

---

## Step 1 — Get the production URL

```bash
APP_URL=$(gcloud run services describe "$SERVICE" \
  --project="$PROD_PROJECT_ID" --region="$REGION" \
  --format='value(status.url)')

echo "$APP_URL"
```

It should print an `https://karos-cmo-....run.app` URL. If it prints nothing, you are in
the wrong project or the wrong region — check both before going on.

## Step 2 — Read the cron secret

It is already in Secret Manager (`bootstrap-prep-gcp.sh` created prep's; production's was
created the same way) and already mounted into the service by `cloudbuild.yaml`. You are
only reading it so the scheduler job can present it.

```bash
CRON_SECRET=$(gcloud secrets versions access latest \
  --secret=CRON_SECRET --project="$PROD_PROJECT_ID")

[ -n "$CRON_SECRET" ] && echo "got it (${#CRON_SECRET} chars)"
```

Checked on 2026-09-18: it exists and is **64 characters**, which is the 32 bytes of
`openssl rand -hex 32` the bootstrap script writes. If you get a different length the
secret was set by hand and is worth re-checking; if you get nothing, read the paragraph
below before creating one.

It prints only the length, not the value. Keep it in the shell variable — do not paste it
into a file, a ticket or a chat. If the command fails, the secret does not exist in the
production project and the route will be answering **503**, not 401; create it first with
`openssl rand -hex 32` and redeploy so the service picks it up.

## Step 3 — Create the job

**Send the output to a file.** `gcloud scheduler jobs create` echoes the job it made, and
that includes the `Authorization` header — so the default is to print the cron secret into
your scrollback, and into anything you paste it into afterwards. The redirect below is the
whole of the fix.

```bash
gcloud scheduler jobs create http followers-sync \
  --project="$PROD_PROJECT_ID" \
  --location="$REGION" \
  --schedule="0 4 * * *" \
  --time-zone="Etc/UTC" \
  --uri="$APP_URL/api/followers/sync" \
  --http-method=GET \
  --headers="Authorization=Bearer $CRON_SECRET" \
  --attempt-deadline=300s \
  --max-retry-attempts=1 \
  --description="SCRUM-495: daily follower counts into clientFollowerSnapshots" \
  >/tmp/followers-sync-create.log 2>&1; echo "exit=$?"

# Read it back WITHOUT the header, which is the one field you must not print.
gcloud scheduler jobs describe followers-sync \
  --project="$PROD_PROJECT_ID" --location="$REGION" \
  --format='value(name,schedule,timeZone,state,httpTarget.uri,attemptDeadline)'
```

Four of those values are deliberate rather than defaults:

| Flag | Why this value |
|---|---|
| `--schedule="0 4 * * *"` | Daily, 04:00 UTC. Daily is both the right cadence and the **maximum useful one**: `capturedAt` is floored to the UTC day, so a second run the same day rewrites the same row rather than adding a point. 04:00 UTC is quiet for the platform APIs and lands before anyone opens the dashboard in Israel. |
| `--time-zone="Etc/UTC"` | The route floors to the **UTC** day. A job in `Asia/Jerusalem` would fire at a time that drifts across the UTC midnight twice a year and silently skip or double a day. |
| `--attempt-deadline=300s` | Matches the route's own `maxDuration = 300`. A shorter deadline would have Scheduler report a failure while the sweep is still running and writing. |
| `--max-retry-attempts=1` | The write is idempotent per day, so one retry is safe and useful. More is pointless: a platform that is down now is down in sixty seconds, and tomorrow's run fills the gap. |

## Step 4 — Run it once by hand, now

Do not wait for 04:00 to find out whether it works.

```bash
gcloud scheduler jobs run followers-sync \
  --project="$PROD_PROJECT_ID" --location="$REGION"
```

Then read what the route actually answered:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="'"$SERVICE"'" AND httpRequest.requestUrl:"/api/followers/sync"' \
  --project="$PROD_PROJECT_ID" --limit=5 \
  --format='value(httpRequest.status, httpRequest.requestUrl)'
```

## Step 5 — Read the answer

A `200` returns a JSON body shaped like this:

```jsonc
{
  "capturedAt": 1789603200000,
  "checked": { "clients": 7 },
  "recordsWritten": 3,
  "unavailable": 2,
  "integrationsExpired": 0,
  "results": [ /* one row per integration it touched */ ]
}
```

What each number means, and what to do about it:

- **`recordsWritten` > 0** — done. That is the first follower count this system has ever
  stored. The audience cell on a client's dashboard needs **two** days of history before it
  draws, so check it again tomorrow rather than today.
- **`recordsWritten: 0` and `unavailable` > 0** — the sweep ran and found nothing it could
  read. Normal, and the `results` array names each one. The two common causes are an
  Instagram connection with no business-account id on file, and a client whose only
  channels are Reddit/TikTok/plain LinkedIn, none of which has a follower endpoint in this
  repo. Nothing to fix; it will stay 0 until a twitter, instagram-with-`pageId`, or
  linkedin_community connection exists.
- **`integrationsExpired` > 0** — a real 401/403. Those channels are now flagged
  `reauthenticate` and the client sees a reconnect prompt. Expected on any long-lived
  token; not a fault of this job.
- **`results` rows with `"action": "skipped"`** — the platform's API erred (a 5xx, a rate
  limit). Left alone on purpose: asking a client to reconnect a working channel because X
  returned a 503 would be worse than the gap. Tomorrow's run fills it.

And the failure codes, which mean three different things:

- **401** — the header did not match. Re-run step 2; you most likely built the job while
  `CRON_SECRET` was empty, so the header went out as `Bearer ` with nothing after it.
- **503** — `CRON_SECRET` is not set **on the service**. The gate fails closed in
  production by design. Check the `--set-secrets` list in `cloudbuild.yaml` reached this
  revision, and redeploy if not.
- **404** — the deployed revision predates the route. Promote a build from `main` at or
  after `c8cb058b`.

---

## Changing it later

```bash
# see it
gcloud scheduler jobs describe followers-sync --project="$PROD_PROJECT_ID" --location="$REGION"

# change the time (still daily, still UTC)
gcloud scheduler jobs update http followers-sync --project="$PROD_PROJECT_ID" \
  --location="$REGION" --schedule="0 5 * * *"

# remove it — delete, don't pause: a paused job is still a billable job
gcloud scheduler jobs delete followers-sync --project="$PROD_PROJECT_ID" --location="$REGION"
```

Deleting it is safe and reversible. Nothing else reads the job; the collection keeps
whatever was already written and the audience cell keeps drawing the history it has, with a
flat line from the day the job stopped. Re-creating it resumes the series with a gap rather
than a rewrite, because each day is its own row.

---

## What this does not cover

**Reddit, TikTok, and the primary LinkedIn connection are not read**, because no follower
endpoint for them is wired in this repo — not because the job skipped them. If you want
those counted, that is new work. For a platform the client has NOT connected, D43 settles
it: we record nothing and say so, rather than buying a scraping provider.

**A client can be connected and still unreadable.** Instagram needs the business-account id
stored as `pageId` (the manual setup writes it; the OAuth path does not), and
linkedin_community needs the org URN in `organizationId`. Both are reported by name in
`results` rather than failing, so the first run tells you exactly which clients need a
field filled in.
