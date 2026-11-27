# DisputeDesk privacy policy

Last updated 27 November 2026.

DisputeDesk is a Forge app for Jira Service Management. This page explains what it stores, where, and who it
shares it with.

## What it stores

For each Paystack dispute event that reaches your webhook URL with a valid signature:

- the Paystack dispute id, status, resolution, category, amount, currency and transaction reference
- the customer's name and email address, and the message they gave Paystack, as Paystack sent them
- the response deadline and a short timeline of events for that dispute

When people use the app:

- which evidence checklist items were ticked, when, and the Atlassian account id of the person who ticked them
- the response sent to Paystack (contest or accept), its message, the attached file's name, and the result
- app settings: the Jira project and issue type, and your Paystack secret key and webhook signing secret, kept in
  Forge's encrypted secret storage

Markers used to skip duplicate deliveries expire after 30 days.

## Where it is stored

Everything is kept in Forge storage on Atlassian's platform, in the site where the app is installed. The developer
does not run any server for DisputeDesk and does not copy this data anywhere else.

## Who it is shared with

- **Your Jira site:** tickets, internal notes and issue properties for each dispute.
- **Paystack:** only when a person in your team chooses to respond to a dispute. DisputeDesk then sends the
  response, the receipt file attached to the ticket and, for fraud claims, the customer details you entered, to
  Paystack's Dispute API using your secret key.
- **Rovo and MCP clients:** the Dispute analyst agent and the MCP tools read disputes and Confluence pages as the
  person using them, with that person's own Jira and Confluence permissions.

## Removing data

Uninstalling the app removes its access to your site; its Forge storage is then handled under Atlassian's Forge
data retention rules. Tickets and notes created in Jira stay in Jira until you delete them.

## Contact

Questions or requests: https://github.com/Olayanju-1234/disputedesk/issues
