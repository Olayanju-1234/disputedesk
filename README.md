# DisputeDesk

Chargeback and dispute desk for Jira Service Management, built on Atlassian Forge.

Paystack expects a response to a dispute within 16 hours. If nobody answers in time, Paystack accepts the
dispute for you and refunds the customer from your balance. DisputeDesk turns every Paystack dispute webhook
into a Jira ticket with the deadline on it, warns the team as the deadline gets close, and closes the ticket as
won or lost when Paystack resolves the dispute.

## How it works

| Part           | Forge module                 | What it does                                                                                                                                                           |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook intake | `webtrigger`                 | Verifies the Paystack signature on the raw body (HMAC-SHA512, constant-time compare), answers fast, queues the event                                                   |
| Processing     | `consumer` (async events)    | Skips duplicate deliveries, ignores out-of-order (stale) updates, creates or updates the ticket, retries with backoff, dead-letters failures                           |
| Deadline sweep | `scheduledTrigger` (5 min)   | Comments and raises priority at 8 h, 4 h and 1 h before the deadline, and once it has passed                                                                           |
| Admin page     | `jira:adminPage` (UI Kit)    | Project and secrets, the webhook URL, a signed test-dispute simulator, recent disputes, dead letters with Replay                                                       |
| Dispute panel  | `jira:issueContext` (UI Kit) | On dispute tickets only: time left, reason, evidence checklist by reason, timeline, and Respond to Paystack (contest with a receipt attached to the ticket, or accept) |
| Dashboard      | `jira:globalPage` (UI Kit)   | Open disputes by deadline, money at risk, win rate, recently resolved, failed events with Replay                                                                       |
| Agent          | `rovo:agent` + `action`      | Dispute analyst: lists and explains disputes, searches Confluence policy pages, drafts evidence and saves it as an internal note only after the user agrees            |
| MCP            | `rovo:mcp`                   | The same four tools for MCP clients such as Claude Desktop or Cursor, through the Atlassian MCP server                                                                 |

Signature checks support both Paystack schemes:

- `Paystack-Signature: t=<unix>,v1=<key id>:<hex>` signed with the webhook signing secret (`whsec_...`) over
  `t.` plus the raw body, with a 300 second replay window and several `v1` values during a secret rotation.
- `x-paystack-signature`, an HMAC-SHA512 of the raw body signed with the secret key (`sk_...`).

When a signing secret is configured, the timestamped header must pass; the app does not fall back to the
legacy header, because that would let an old captured event skip the replay window.

The agent and MCP tools read Jira and Confluence as the person asking (`asUser`), so they only see disputes and
pages that person can already open. Nothing is ever sent to Paystack by the agent; responses go through the
panel, with a confirm step.

Each dispute is processed one event at a time (queue concurrency key per dispute), so two deliveries of the same
event cannot both open a ticket. Paystack resends the same body on retry, so the dedupe key is the dispute id,
event name and `updated_at`.

## Develop

Needs Node 24.22.1 or newer (the Forge CLI requires it).

```bash
nvm use
npm ci
npm run check
```

`npm run check` runs ESLint, Prettier, the TypeScript build and the tests. Tests use Node's built-in runner on
Paystack's documented sample payloads, with signatures checked against values computed separately with
`openssl dgst -sha512 -hmac`.

## Deploy

```bash
forge register
forge deploy
forge install --product jira
```

### Set up the service project

1. Create a Jira Service Management space for disputes. The "Finance service management" template works well.
2. Add a request type called **Dispute**, and add the **Description** and **Due date** fields to it.
3. In the Dispute workflow, add two statuses in the Done category, **Won** and **Lost**, each with "Allow
   transitions from any status". DisputeDesk moves the ticket there when Paystack resolves the dispute. If
   neither exists it uses any transition into a Done status, and leaves the ticket where it is if there is none.

DisputeDesk installs once for Jira (required) and can also use Confluence on the same site (optional). Add
Confluence to the installation to let the agent search policy pages; without it, everything else works and the
agent says it can't search Confluence.

### Configure the app

Open the app's Configure page (Manage apps, DisputeDesk, Configure). Pick the project and the Dispute issue
type, save your Paystack secret key (and the webhook signing secret if your dashboard shows one), and paste the
webhook URL into the Paystack dashboard under Settings, API Keys and Webhooks.

Comments from DisputeDesk are internal notes, so customers on the portal never see them.

### Use the tools from an MCP client

The tools are `list-open-disputes`, `get-dispute`, `find-policy-pages` and `save-evidence-draft`, served at
`https://mcp.atlassian.com/forge/6ee2aed7-5ef0-4e3b-87de-cbcd3b095db7`. External access is off by default: a site
admin turns the tools on in Atlassian Administration under Apps, Sites, the site, Connected apps, DisputeDesk.
Then, for example in Claude Code:

```bash
claude mcp add --transport http disputedesk https://mcp.atlassian.com/forge/6ee2aed7-5ef0-4e3b-87de-cbcd3b095db7
claude mcp login disputedesk
```

The sign-in lets you pick a site where the app is installed and its tools are turned on, and the tools then run
with your own Jira and Confluence permissions.

## Try it without a Paystack account

Paystack does not document a way to raise disputes in test mode, so the admin page has a simulator. Save any
test-format secret (for example `sk_test_demo1234`), choose a project, then use "Send a signed test dispute".
The simulator signs a Paystack-shaped event with your saved secret and posts it to the real webhook URL, so it
goes through the same signature check, queue and ticket logic as a live event. Send "New dispute", then
"Paystack reminder", then one of the resolve scenarios, and watch the ticket change.
