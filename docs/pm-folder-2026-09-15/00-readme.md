# Product Management folder

Approved 2026-09-15. Owner: Albert.

The Word files here are exports. The master is the markdown in the portal repo, and git history is the changelog. The feedback workbook's master is the Google Sheet.

## What is in it

| File | What it is | Owner |
|---|---|---|
| 01 Flow and Agents | The product in the client's words. One page per agent: what it does, who owns it, the strategy, slots for examples | Albert, Anna |
| 02 Learning Loop and Reporting | The full scope. What each step reads and writes, the stores, reporting, and where the code stands today | Albert; developers update "where we stand" |
| 03 Connectors and posting | Per platform: what we can post and read, what the client has to connect, autopilot or manual, build or buy | Albert |
| 04 Build plan | The work. What to integrate, what to add, who builds what | Albert |
| 05 Decisions log | Every settled decision with its date. Every open one with its owner | Albert only |
| 06 Agent Improve | The feedback workbook. One tab per agent, one row per finding, with a directive and a status | Testers log, Albert and Anna direct, developers close |
| 07 Pricing model | The two plans and the unit economics | Albert |
| 09 Glossary | The words that have two meanings | Albert |
| Craft/ | Best practices per platform, how they layer per sector and per client, the humanizer, the strategy template | Albert, re-researched quarterly |

## Where to start

Developers: 01, then 05. Read 04 and 02 before you pick up work. Setup, conventions and environments are in the repo, not here.

Testers: 06, then the agent's page in 01. To test a run: sign in as staff, open the client, open the agent, press Run with a one-line note, then open the delivered post. Log one row per finding in 06. Severity is one question, would you post it as delivered. The pre-delivery checklist for that platform is section 10 of its Craft page.

## Who is who

| Name | Role | Owns |
|---|---|---|
| Albert Kattan | Founder, product | The decisions, the Craft pages, and the Newsletter, Blog and Landing page agents |
| Anna | Product, with Albert | Feedback directives in 06, agent pages in 01 |
| Tomer Erel | Developer | Instagram agent, portal UI, the engine with Shlomi. Opens the platform accounts and files the applications (D37) |
| Shlomi Gueta | Developer | X, LinkedIn, Reddit and the three TikTok agents, the engine with Tomer |

Merges to main deploy to prep automatically. Production is promoted by hand, by Tomer or Shlomi, and never as part of a doc change.

## Rules

1. A decision lives in 05 and nowhere else. Other files link to its id.
2. Every claim carries a source: a URL with a date, a file and line, or a decision id.
3. A work item has one id, from 04, Craft or 03. That same id goes on the Jira ticket, the pull request and the feedback row. Jira holds the status, this folder holds the scope and the reason.
4. Superseded files come out of the folder. The repo's git history keeps them.
5. If two files disagree, the lower number wins. 05 beats 04, 04 beats 02.

## Rituals

- **Monday, 30 minutes.** Albert and Anna read the new rows in 06 and write directives. Developers pick up the rows marked to do.
- **Friday.** Developers add the pull request link to the rows they closed, and update "where we stand" in 02.
- **Quarterly.** The Craft pages are re-researched, dated and the old ones archived.

## Adding a platform or agent

One page in 01, one page in Craft, one block in 03, one tab in 06. Then the ids in 04.
