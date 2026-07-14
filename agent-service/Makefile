# Local dev workflow for the agent service.
#   make up         — build + start api, worker, redis, egress proxy, mock webhook
#   make runner     — build the job-runner image (set GITHUB_TOKEN for a private agents repo)
#   make demo-job   — run a sample job end to end against the local stack
#   make down       — stop everything

AGENTS_REPO_REF ?= main

# Make's $(if) splits on commas, so the comma inside the --secret value must
# be escaped through a variable.
COMMA := ,
SECRET_FLAG = $(if $(GITHUB_TOKEN),--secret id=github_token$(COMMA)env=GITHUB_TOKEN)

up:
	docker compose up -d --build

runner:
	docker build -f runner/Dockerfile \
		$(SECRET_FLAG) \
		--build-arg AGENTS_REPO_REF=$(AGENTS_REPO_REF) \
		-t karos-agent-runner:latest .

demo-job: up
	npm run demo-job

logs:
	docker compose logs -f api worker proxy

down:
	docker compose down

proxy-filter:
	npm run gen:proxy-filter

test:
	npm test

.PHONY: up runner demo-job logs down proxy-filter test
