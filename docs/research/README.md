# Research Library

Papers and write-ups downloaded locally, grouped by the design question each
one answers. Every spec in [`issues/`](../../issues/README.md) should be
arguable against something in here, not against intuition.

Local copies so the specs stay citable offline. Keep attribution with the
original source; nothing here is ours to license.

---

## 1. Why we do not use distributed transactions

**Sagas** — Garcia-Molina & Salem, 1987
`garcia-molina-1987-sagas.pdf`

The original compensation pattern. The part that matters for payments is
that a compensating transaction does not restore a prior state, it applies
a *new* semantic action: cancelling a seat reservation is not decrementing
a counter back to its old value, because other transactions ran in between.

This is the direct justification for our ledger rule. A refund does not
un-write a capture. It posts new, balanced legs and leaves the original
entry standing. Helland's paper below says the same thing from the other
direction.

**Life beyond Distributed Transactions: an Apostate's Opinion** — Helland, CIDR 2007
`cidr2007-helland-life-beyond-distributed-transactions.pdf`

The argument against two-phase commit, from someone who spent a decade
building platforms that offer it. Two ideas we adopt directly:

- Bound atomicity to a single entity you own. Cross-entity coordination
  happens in business logic, not in locks.
- Hold uncertainty in the *business semantics*, not in a record lock. A
  `payment_intent` in `processing` is a domain state meaning "we do not
  know yet", and it must be a first-class state — not a timeout, not a
  retry counter.

Read before designing anything that spans the payments service, the ledger,
and a processor.

---

## 2. Exactly-once, and the parts we actually get

**Exactly-Once State Machine and Checkpointing in Apache Flink** — Carneiro et al., 2016
`carneio-2016-exactly-once-semantics-apache-flink.pdf`

The honest framing: exactly-once is achieved by *practically-once* state
transitions plus replay. A retried operation must land on the same state,
and the pipeline must be replayable from a checkpoint.

Applied to us: an idempotency key is not a cache, it is a durable record
that the operation is allowed to be re-executed and must converge. That is
why `0001` stores the *first response* and replays it byte-identically,
rather than recomputing a possibly-nondeterministic result.

**Reliable Payment Processing in Ultra-Large-Scale Systems** — Schmidt, 2026
`schmidt-2026-reliable-payment-processing-at-ultrascale.html`

Case study walking a card payment end to end at billions-per-quarter scale.
Two details worth stealing:

- **Provider-sticky routing.** The idempotency record binds the key to the
  specific processor that received the first request. A retry must go back
  to that same provider. Without affinity, a retry during a processor
  failover becomes a duplicate charge at a different gateway. We need this
  in the multi-processor design (`0001`, `0013`).
- **Immutability verified by sealing.** Time-windowed manifests with
  checksums and a signature over the manifest, so tampering is detectable
  after the fact rather than merely forbidden. Cheaper to operate than
  trying to prevent every write path.

Also useful for `0018`: the ledger is the only place allowed to assert a
balance, and checksum validation runs continuously rather than in the daily
batch.

---

## 3. Global scale and time

**Spanner: Google's Globally-Distributed Database** — Corbett et al., OSDI 2012
`corbett-2012-spanner-googles-distributed-global-scale-database.pdf`

Included as the counterexample, not the model. Spanner gets external
consistency with TrueTime because it can afford commit-wait and a
world-spanning consensus group.

Our case is different and the difference decides the architecture:
external consistency is not needed, cross-region synchronous writes are not
acceptable, and we have a hard latency budget on the authorization path.
The relevant takeaway is the truth-vs-availability tradeoff stated
plainly, and the demonstration that a system can choose per-operation. We
choose serialization per account, not global consensus.

`0013` documents why regional failover is deliberately broken: one ledger
of record, one writable copy.

---

## 4. Payment platform architecture, in the wild

**Optimizing Payment Systems with Microservices and Event-Driven Architecture: The Case of Mollie** — Wang, UvA MSc thesis
`wang-mollie-platform-microservices-event-driven-payment-thesis.pdf`

A real high-frequency PSP, decomposed. Useful as a bounded-context sanity
check: the natural split separates primary payment services from accounting,
and onboarding/risk from both. That matches the service boundaries in
[`docs/architecture/overview.md`](../architecture/overview.md).

The failure modes it names are the ones we design against: event
duplication, external API dependencies in the critical path, and resource
overhead from over-decomposition. Note the recommendation to start with a
modular monolith and split along the values of the business, not along
infrastructure layers.

---

## 5. Fraud detection

**Fraud Detection in Mobile Payment Systems using an XGBoost-based Framework** — Hájek, Abedin & Sivarajah, 2022
`hajek-xgboost-mobile-payment-fraud-detection.html`

Evaluated on 6M+ transactions. The contribution worth taking is not the
model, it is the **cost-savings measure**: a detection metric defined as
the money saved from catching fraud minus the margin lost to false
positives. That is the number `0010` should optimize, and the number the
dashboard should show merchants. Accuracy on an imbalanced fraud dataset
is close to meaningless.

Also: semi-supervised outlier detection feeding a supervised classifier,
because labelled fraud is scarce and fraudsters drift.

**Financial Fraud Detection Using Explainable AI and Stacking Ensemble Methods** — 2025
`financial-fraud-detection-xai-stacking-ensembles-2025.pdf`

Graduated boosting ensemble (XGBoost / LightGBM / CatBoost) with SHAP,
LIME, PDP, and permutation importance. Two things matter for `0010`:

- Gradient-boosted trees are the right default for this problem shape. Our
  spec already says so; this is the evidence.
- Explainability is not optional garnish. A merchant whose legitimate
  customer is blocked at 3am needs a reason, and our support team needs the
  same reason. SHAP-based feature attribution should drive the `review`
  queue, not just the offline evaluation.

---

## 6. Reliability practice

**Monitoring Distributed Systems** — Google SRE
`google-sre-monitoring-distributed-systems.html`

The four golden signals, plus the argument that a distributed system is
observed from the outside by a black-box user. For us the black-box user is
a merchant trying to charge a card, which makes the hourly synthetic test
charge in `0018` the single most important dashboard on the system.

**Embracing Risk and Error Budgets** — Google SRE
`google-sre-embracing-risk-and-error-budgets.html`

Error budgets as a release-speed control rather than a postmortem artifact.
`0018` ties planned releases to the 99.99% target; this is where that
policy comes from. The chapter on the cost of unavailability as a business
number, not an uptime number, is the framing for `0016` unit economics.

**SRE Book table of contents** — `google-sre-book-toc.html`

Index for chasing down specific chapters later. Not required reading.

---

## How to use this

Before writing or approving a spec, check whether the file already answers
the question the spec is trying to answer. When a spec makes a claim that
rests on a design principle, cite the paper in the issue file. When a spec
contradicts something here, the spec wins only if the issue says why.

## Gaps

Known holes in the library, to fill:

- **Double-entry bookkeeping in software.** The classic texts are not free
  and there is no obvious canonical paper. Practical substitutes: the
  accounting-for-engineers material, and the immutable-ledger descriptions
  in section 2.
- **PCI DSS scope reduction.** The standard itself is authoritative and
  freely available; the research literature on tokenization architectures is
  thinner than expected. Fill with the PCI SSC's own guidance.
- **3-D Secure 2.** Mostly vendor documentation. Worth a survey paper if
  one exists on step-up authentication and friction trade-offs.
- **Regional payment rails** (UPI, PIX, SEPA Instant, FedNow). Very
  little neutral academic writing; mostly central bank working papers.
  Start with each scheme's own operator documentation.
- **Chargeback representment and evidence strategy.** Effectively
  unpublished. This is a real gap and a real differentiator, and it is
  where we should write the primary source ourselves.
