# 0017 — Compliance, PCI scope, KYC/KYB

**Phase:** 3 · **Status:** planned

## Problem

Compliance is not a feature you add later — it is the license to operate.
The goal is to keep our PCI scope minimal and to make the regulatory
obligations a property of the system rather than a document somebody
maintains.

## Scope

### PCI DSS

- SAQ A eligibility: no electronic storage, no processing, no transmission of
  cardholder data on our systems. Enforced architecturally, verified by
  network capture in CI.
- SAQ A-DP or SAQ A-EP fallback plan documented, with the trigger
  conditions and the migration timeline.
- Annual SAQ, quarterly ASV scan, and an incident-response plan with a
  named owner and a rehearsed timeline.
- Tokenization coverage: every path, including refunds, disputes, and
  support tooling.

### KYC / KYB

- Business verification: legal entity, beneficial owners, business
  documents, sanctions screening.
- Individual verification for platform sellers and payout recipients.
- Ongoing monitoring with re-verification triggers, not one-time checks.
- Risk rating per account driving reserve percentage, review requirements,
  and payout limits.
- Manual review queue with a documented SLA and evidence capture.
- Webhook events for verification state so platforms can gate their own
  onboarding flow.

### Regulatory

- KYC/AML transaction monitoring: structuring detection, velocity
  thresholds, high-risk corridor rules.
- Sanctions and PEP screening on payouts and recipients.
- Data subject tooling: access, correction, and deletion requests, with
  financial-record retention exemptions handled explicitly.
- Tax: nexus determination per region, tax-inclusive pricing support,
  reporting obligations, and remittance where we are the merchant of record
  in a jurisdiction.

### Operational

- Annual third-party penetration test with remediation SLAs.
- Vendor and subprocessor register with change notification.
- Evidence collection automated so audits are a query, not a quarter-long
  project.

## Acceptance criteria

- [ ] PCI scope statement signed off by an external assessor before launch.
- [ ] Automated network capture in CI fails the build on any cardholder
      data reaching our application tier.
- [ ] Sanctions screening runs before every payout and before every new
      recipient; a match holds the payout.
- [ ] Account risk rating changes take effect on reserve and limits within
      one cycle.
- [ ] A DSAR request completes with financial records exempted per the
      documented retention rule.
- [ ] Subprocessor changes notify affected merchants before they take
      effect.

## Dependencies

- `0003` (scope reduction is a direct consequence of the vault design),
  `0005` (retention and immutability), `0010` (risk signals feed account
  rating), `0015` (payout screening).
