---
name: disputedesk
description: Works Paystack payment disputes tracked by the DisputeDesk app for Jira Service Management, through its MCP tools. Lists open disputes by deadline, reads one dispute's details and evidence checklist, searches Confluence for the merchant's refund or delivery policy, and saves an evidence draft as an internal Jira note. Use when the user asks about chargebacks, payment disputes, Paystack disputes, dispute deadlines, or drafting dispute evidence.
license: MIT
compatibility: Needs the DisputeDesk MCP server (https://mcp.atlassian.com/forge/6ee2aed7-5ef0-4e3b-87de-cbcd3b095db7) connected, on an Atlassian site where DisputeDesk is installed and its tools are enabled.
metadata:
  author: Joseph Olayanju
  version: '1.0'
---

# DisputeDesk disputes

DisputeDesk turns Paystack dispute webhooks into Jira Service Management tickets. Its MCP tools let you read
those disputes and help a person prepare a response. A person always sends the response, from the DisputeDesk
panel on the ticket.

## Tools

Your client may prefix these names with the server name.

| Tool                  | Input                           | Returns                                                                                                |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `list-open-disputes`  | none                            | Open disputes, most urgent first: ticket, amount, reason, time left, evidence progress, response       |
| `get-dispute`         | `issueKey`, for example `DIS-6` | One dispute: amount, reason, customer message, deadline or outcome, checklist, response, recent events |
| `find-policy-pages`   | `query`, for example `refund`   | Up to 5 Confluence pages with title, link and excerpt                                                  |
| `save-evidence-draft` | `issueKey`, `draft`             | Confirms the draft was saved as an internal note on the ticket                                         |

Every tool runs with the signed-in person's Jira and Confluence permissions, so it only sees disputes and pages
they can open. Over MCP there is no "current ticket", so always pass `issueKey`. If the user hasn't named one,
call `list-open-disputes` and ask which.

## If the tools fail

- **"Authentication Required" or no tools listed.** The person hasn't allowed access yet. Tell them to open the
  DisputeDesk admin page in Jira and click **Allow access for MCP tools**, then sign in to the MCP server again.
- **Tools missing for the site.** A site admin turns them on in Atlassian Administration: Apps, Sites, the site,
  Connected apps, DisputeDesk, **Enable tools**.
- **"is not a DisputeDesk dispute, or you don't have access to it".** Relay it as is. Don't guess at the ticket.
- **"I could not search Confluence".** DisputeDesk isn't added to Confluence on that site, or the person lacks
  access. Carry on without policy pages and say so.

Don't retry a failing call in a loop. Report the message and stop.

## Facts you may state

- Paystack expects a response to a dispute within 16 hours. If nobody responds before the deadline, Paystack
  accepts the dispute on the merchant's behalf and refunds the customer from the merchant's Paystack balance.
- To contest, the merchant uploads a receipt (PDF or JPEG) and declines the dispute. For fraud claims Paystack
  also asks for the customer's name, email and phone, what was provided, and optionally the delivery address and
  date.

State no other Paystack rule, fee, time limit or outcome. If the user asks about something these facts and the
tool results don't cover, say you don't know and point them to Paystack's documentation or support.

## Workflows

### Which disputes need attention

1. Call `list-open-disputes`.
2. Lead with the most urgent one and its time left. Mention any under 4 hours by name.
3. If a line says "simulator test data", say it is test data, not a real customer.

### Review one dispute

1. Call `get-dispute` with the issue key.
2. If it's open, say the time left first, then the reason, the amount and what the customer said.
3. List the unticked checklist items as the evidence still missing.
4. If it's resolved, give the outcome and stop. There's nothing left to respond to.

### Draft a response

1. Call `get-dispute` for the facts.
2. Call `find-policy-pages` with words that fit the reason, such as `refund policy`, `delivery` or `terms`.
3. Write the draft from the evidence for that reason (below). Quote policy pages only as they read, with the
   page title. If no page was found, say so and leave a clear placeholder such as `[refund policy: add link]`.
4. Use only facts from the tools. Never make up an amount, date, customer detail, tracking number or policy.
5. Show the draft to the user and ask whether to save it.

### Save the draft

Call `save-evidence-draft` only after the user agrees to that exact text. Then tell them it's saved as an
internal note and that nothing was sent to Paystack: they respond from the DisputeDesk panel on the ticket.
Never say a response was sent.

## Evidence by reason

| Reason                        | Evidence that fits                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Goods or service not received | Proof of delivery with date and address, the receipt, messages confirming delivery                                    |
| Charge not recognised         | Order details and the customer contact details used, to show they match the cardholder                                |
| Charged more than once        | Proof the charges are separate orders, or the refund reference                                                        |
| Fraud claim                   | Customer's name, email and phone, delivery details, what was provided, earlier undisputed orders by the same customer |
| Other chargeback              | The receipt, order details, messages with the customer                                                                |

## Style

Keep answers short and plain. Put the deadline first whenever it's close.
