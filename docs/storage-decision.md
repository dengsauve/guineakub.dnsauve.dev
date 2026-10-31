# Durable storage decision — approved for implementation

Research date: 2026-10-31. No resources were created, no subscription was accessed and no infrastructure was changed. This document proposes a storage choice and a storage-only cost target; it does not approve provisioning.

## Recommendation and alternatives

Use one Azure StorageV2 account with Standard performance, Hot block blobs, a flat namespace (hierarchical namespace disabled), and locally redundant storage (LRS). Place it in the same region as the game server. West US 2 is the pricing example, not an approved deployment region.

| Option        | Fit for Guineakub                                                                                                                                                                       | Decision                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Blob Storage  | A room's full JSON snapshot, revision and command receipts can share one conditional object write.                                                                                      | Recommend: simplest representation for the existing pure engine state.                                       |
| Table Storage | Good for structured entities, but a string/binary property is limited to 64 KiB and an entity to 1 MiB. Growing JSON snapshots/receipts require property chunking or multiple entities. | Viable, but extra modeling is unnecessary for this small workload. Do not claim Blob is universally cheaper. |

The Table limits are documented in Microsoft's [Table data model](https://learn.microsoft.com/en-us/rest/api/storageservices/understanding-the-table-service-data-model). The choice above is an engineering judgment based on the existing snapshot model. Hot is appropriate for frequent updates and short-lived rooms; cooler tiers have longer minimum storage periods and different access charges. See [access tiers](https://learn.microsoft.com/en-us/azure/storage/blobs/access-tiers-overview).

LRS stores replicas within one datacenter. It meets the intended process/container restart recovery need, but a datacenter disaster could lose the game. It is not a regional-disaster backup. ZRS is an alternative if the owner wants protection across availability zones; LRS is proposed as the minimal option for ephemeral family game nights. See [redundancy tradeoffs](https://learn.microsoft.com/en-us/azure/storage/common/storage-redundancy).

## Price evidence and estimate

Microsoft's [public retail API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) was queried directly in USD for `Storage`, `westus2`, `Consumption`, product `General Block Blob v2`, SKU `Hot LRS`. Hierarchical-namespace and reserved-capacity products were excluded from the estimate. Query:

```text
https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27westus2%27%20and%20priceType%20eq%20%27Consumption%27%20and%20contains(productName,%20%27General%20Block%20Blob%27)&currencyCode=USD
```

Retrieved meters, lowest storage-capacity band:

| Meter                                    |           USD rate | API effective start |
| ---------------------------------------- | -----------------: | ------------------- |
| Hot LRS Data Stored                      | $0.0184 / GB-month | 2017-02-03          |
| Hot LRS Write Operations                 |     $0.05 / 10,000 | 2016-07-11          |
| Hot Read Operations                      |    $0.004 / 10,000 | 2016-07-11          |
| LRS List and Create Container Operations |     $0.05 / 10,000 | 2018-12-01          |
| All Other Operations                     |    $0.004 / 10,000 | 2017-10-01          |

These are rates returned at the research date; the effective-start dates are meter dates, not evidence of a stale lookup. Recheck the chosen region/subscription before provisioning. Retail prices are not an account-specific quote. The [Blob pricing page](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) explains operation classes; its dynamically rendered dollar fields were unavailable to the text browser, so the estimate uses API results instead.

Illustrative monthly usage, including room recovery, enrollment records and presence-boundary writes:

| Usage assumption              | Calculation |           USD/month |
| ----------------------------- | ----------- | ------------------: |
| 1 GB average retained storage | 1 × 0.0184  |              0.0184 |
| 10,000 writes                 | 1 × 0.05    |              0.0500 |
| 10,000 reads                  | 1 × 0.004   |              0.0040 |
| 1,000 list/create operations  | 0.1 × 0.05  |              0.0050 |
| **Illustrative total**        |             | **0.0774 (~$0.08)** |

At 100,000 writes and 100,000 reads, with the same capacity and list assumptions, the estimate is $0.5634/month. These are workload estimates, not measured usage or hard limits. Full snapshot rewrites count as writes; chunked uploads may use additional operations, so keep small snapshots to single-blob uploads and measure actual usage. Do not persist every WebSocket heartbeat. Monitor snapshot/receipt size and operation counts as part of implementation.

Recommend a **storage-only target below $1/month** at this family workload, without depending on free-account grants. A budget alert is not a spending cap. Compute, registry, logs, monitoring, network transfer, DNS/domain charges, private endpoints, optional protection features and taxes are excluded. This is not an estimate for the complete application. Do not enable paid add-ons implicitly. Reprice if workload, region or retention changes.

## Consistency and commit design

Azure Blob Storage provides strong consistency after writes. ETag-based `If-Match` updates reject conflicting writes with HTTP 412. Use a create-only condition for new rooms, conditional updates for existing rooms and a serialized command queue per room. See [concurrency guarantees](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage).

Proposed object layout inside a non-anonymous application container:

- `rooms/<opaque-room-id>.json`: schema version, complete engine room, original/acting host IDs, membership, invitation lookup material, expiry/presence-boundary metadata, revision and command receipts. Keep each accepted room mutation and its receipt in this same atomic object update.
- `accounts/family.json`: verified Google subject identities, pending/approved status and approval metadata; update conditionally. This registry outlives game-night rooms so the owner need not reapprove everyone each night.

Store receipts for the room's lifetime, keyed by authenticated actor and command ID, with a payload hash and outcome/revision. Never silently evict a receipt in a way that makes an old accepted command executable again. Bound request sizes and outstanding commands; if a receipt/snapshot limit is reached, fail safely rather than dropping deduplication history. Exact byte bounds and a load test belong in implementation. A short-code index can be reconstructed from live room objects at startup for this single-replica scale; do not add a database solely for that index.

On an uncertain write response, reload and inspect revision/receipt before returning an outcome or retrying. On conflict, reload and revalidate; never overwrite with last-writer-wins. A failed persistence attempt sends no success acknowledgment or committed-state broadcast. On restart, validate schema and engine invariants before serving any room; reject corrupt/unknown snapshots rather than quietly starting a fresh game. Redis or a distributed coordinator is unnecessary for the single-replica design.

## Access controls

Propose the Container App's managed identity with container-scoped Storage Blob Data Contributor access. The browser receives neither storage credentials nor SAS URLs. Disable anonymous blob access at account and container level, disable Shared Key authorization, require HTTPS/TLS and use Microsoft-managed encryption at rest. Microsoft recommends [managed identity/Entra authorization](https://learn.microsoft.com/en-us/azure/storage/blobs/authorize-access-azure-active-directory) and [disabling Shared Key](https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent).

A container with anonymous access disabled is not a private network endpoint. The minimal proposal uses Azure's authenticated HTTPS endpoint; no billable private endpoint is included. Restrict deployment/operator permissions separately, and never log snapshots, raw Google tokens, session credentials, invitation secrets or private racks. Secure account configuration must be verified during the eventual approved deployment.

## Expiration, physical cleanup and recovery scope

The approved product behavior remains: rooms/scores expire 24 hours after everyone disconnects; reconnecting before expiry cancels that timer, and End Game Night closes immediately. Persist an authoritative expiry deadline at the all-disconnected transition. Ordinary heartbeat traffic stays in memory. A crash can bypass disconnect handlers, so implementation must preserve a recent bounded liveness checkpoint and specify/test how recovery derives the all-disconnected boundary; do not silently restart the 24-hour timer on every server restart.

Check expiry before any join/resume/command. Reject expired/closed rooms immediately. Sweep their stored snapshots/receipts when the app is running and at startup; a min-zero server may leave inaccessible expired objects physically stored until its next wake. No separate paid cleanup scheduler is proposed. This meets room unavailability at expiry, but does not promise physical deletion at that exact second.

Propose no room snapshot history, versioning or soft-delete retention for MVP; this keeps game-night data temporary and costs predictable. Therefore the recovery promise is from the latest accepted durable snapshot, not operator deletion or application corruption. If the owner wants rollback backups, define retention and cost separately. Azure's [deletion documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-delete) explains how soft delete changes deletion behavior. Family approvals remain until administratively removed; room expiration does not delete the allowlist.

## Approval recorded

The owner approved this storage design for implementation: Standard Hot LRS Blob Storage, container-scoped managed identity access, latest-state recovery only, deferred physical cleanup while scaled to zero, and a storage-only target below $1/month under the assumptions above. This does not authorize resource creation, paid provisioning, DNS changes or production deployment. Subscription, region and full application budget remain separate pre-deployment decisions.
