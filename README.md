# Mycelium

**The per-operator, witnessed, append-only record layer for Janus-Facing Architecture networks.**

Mycelium is the *record* layer of a mutual-credit network built to the [Janus-Facing
Architecture](https://github.com/NTARI-RAND) standard: the immutable, tamper-evident
account of *what happened* between participants — transactions, ratings, and
adjudications — that the reputation layer (LBTAS) reads from and the economy layer
settles against. Its one job is to make the record of an exchange **legible, portable,
and impossible to quietly rewrite**.

Its design philosophy is **detection, not prevention**: tampering is not made
impossible, it is made *evident*.

- 📄 **[SPEC.md](SPEC.md)** — the normative specification (P3-013). This repository is its canonical home.
- 🧩 **[mycelium.js](mycelium.js)** — a storage-agnostic JavaScript reference implementation.
- ▶️ **[example.js](example.js)** — a runnable demo + smoke test of the guarantees.

## The shape of it

- **The dialog is the atomic unit.** One append-only file per exchange, accumulating the
  whole story in order: opening, messages, the money lifecycle, ratings, any audit.
- **Two hash chains.** *Intra-dialog* — each transmission folds into a running head hash
  (`h_i = H(h_{i-1} ‖ Cᵢ)`), so an open dialog is tamper-evident as it is built.
  *Per-operator* — sealed dialogs chain within one operator's log
  (`anchor.hash = H(prev ‖ canonical(anchor))`).
- **Seal only when complete and quiescent.** Complete: every party owed a rating has one
  (a non-rater gets a *marked* `+2` default, so silence is never read as praise).
  Quiescent: no open audit — a harm claim (`−1`) holds the seal open, in both directions,
  until it is answered.
- **Annotate, never erase.** A front end may forgive a harm; it can never hide one. A
  dismissal is a new, separately-anchored record, not an edit.
- **No PII in the commons.** Only structural facts and references are ever hashed. The
  free-text narrative and anything identifying stay operator-local — which is what lets an
  immutable record coexist with a right to be forgotten.
- **Per-operator, not global.** There is **no** global chain and **no** consensus layer.
  Each operator keeps its own log; cross-operator non-equivocation comes from
  **witnessing** (signed monotonic checkpoints to independent witnesses — the
  [Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962) model).

## Quick start

```bash
node example.js
```

```js
const { Mycelium } = require('./mycelium');

// One instance == one operator's log (there is no global chain).
const myc = new Mycelium({ operatorId: 'op-01' });

myc.append('dialog-1', { type: 'dialog_open', actorId: 'buyerA', actorRole: 'buyer', data: { post: 'post-7' } });
myc.append('dialog-1', { type: 'paid',        actorId: 'buyerA', actorRole: 'buyer', data: { ref: 'pay-1' } });
myc.append('dialog-1', { type: 'rating',      actorId: 'buyerA', actorRole: 'buyer', data: { rated_role: 'market_seller', value: 3 } });

myc.seal('dialog-1');            // fix the file hash, anchor it on this operator's chain
myc.verify();                    // => { ok: true, anchors: 1 }
```

`data` MUST carry **references only** — never free text or PII (SPEC §6).

### API

| Method | Purpose |
|---|---|
| `append(dialogId, txn)` | Add a transmission to an open dialog (SPEC §3). |
| `seal(dialogId)` | Anchor a complete + quiescent dialog; idempotent (SPEC §4). |
| `annotate(dialogId, txn)` / `record(dialogId, txn)` | Post-seal annotation — reference the sealed dialog, never edit it (SPEC §7). |
| `verify()` | Recompute this operator's chains; report the first break (SPEC §8). |
| `forDialog(dialogId)` / `listAnchors(limit)` | Read the record. |
| `checkpoint()` | Produce a checkpoint body for witnessing — **stub; not built** (SPEC §5.1). |

The store is pluggable: implement the same append-only interface as `InMemoryStore`
(SQL, KV, or files) and pass it as `store`. The hash and clock are injectable too.

## Honest status

Per the JFA method, this repo ships its status plainly rather than performing the
absence of a gap.

**Built.** The dialog-file model, both hash chains, seal / annotate / verify, tamper
detection, PII-free hashing, post-seal annotation.

**Not built (intended).**

- **Witnessing** — signed checkpoint publication, independent witnesses, and
  cross-operator inclusion proofs. Until this exists, non-equivocation rests on there
  being a **single backend**, and a log is effectively one operator's. This is the single
  highest-leverage step toward real federation (SPEC §5.1).
- **Per-transmission operator signatures** — the reference impl records structure and
  order; the Agrinet protocol (P3-012 §2) defines the rotating-key signing that rides
  with operator onboarding.

**Out of scope.** Mycelium attests the *sequence and integrity* of the record — not the
honesty of the *computation inside* a transmission (a rigged match or price). That is
checked by legibility and cheap exit (SPEC §9).

## Related

- **Janus-Facing Architecture** — the builder's guide and the operating brief (NTARI).
- **[Agrinet](https://github.com/NTARI-RAND/Agrinet)** — the protocol (P3-012) and the first operator; Mycelium is its record layer.
- **[LBTAS](https://github.com/NTARI-RAND/Leveson-Based-Trade-Assessment-Scale)** — the reputation covenant whose rating events are Mycelium records.

## License

[GNU AGPL-3.0](LICENSE) — free documentation and software, meant to be read,
reimplemented, and contested.

*Network Theory Applied Research Institute, Inc. — 501(c)(3) — info@ntari.org*
