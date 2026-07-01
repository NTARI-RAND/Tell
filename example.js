/**
 * Mycelium reference implementation — runnable demo + smoke test.
 *
 *   node example.js
 *
 * Walks the worked examples from SPEC §11 and asserts the guarantees of §9:
 * append-in-order, seal, chain verification, tamper detection, and post-seal
 * annotation (annotate-never-erase).
 */
'use strict';

const assert = require('assert');
const { Mycelium, InMemoryStore } = require('./mycelium');

let n = 0;
const ok = (label) => { n++; console.log(`  ✓ ${label}`); };

// Deterministic clock so runs are reproducible.
let t = 1_700_000_000_000;
const clock = () => (t += 1000);

const myc = new Mycelium({ operatorId: 'op-agrinet-01', store: new InMemoryStore(), now: clock });

console.log('Mycelium reference implementation — demo\n');

// ---- 1. Ready-market purchase: fast settlement, late seal (SPEC §11) ----
console.log('1) ready-market purchase');
const d1 = 'dialog-0001';
myc.append(d1, { type: 'dialog_open', actorId: 'buyerA', actorRole: 'buyer', data: { post: 'post-77' } });
myc.append(d1, { type: 'transaction_created', actorId: 'buyerA', actorRole: 'buyer', data: { amount: 100, qty: 1 } });
myc.append(d1, { type: 'paid', actorId: 'buyerA', actorRole: 'buyer', data: { ref: 'pay-1', escrow_locked: true } });
myc.append(d1, { type: 'rating', actorId: 'buyerA', actorRole: 'buyer', data: { rated_role: 'market_seller', value: 3 } });
myc.append(d1, { type: 'escrow_settled', actorId: 'system', actorRole: 'system', data: { beneficiary: 'sellerB', amount: 100 } });
// producer's window expires -> marked +2 system default (SPEC §4.1)
myc.append(d1, { type: 'rating', actorId: 'system', actorRole: 'system', data: { rated_role: 'market_buyer', value: 2, timeout_default: true } });
const seal1 = myc.seal(d1);
assert.ok(seal1 && seal1.hash, 'dialog 1 sealed');
assert.strictEqual(myc.forDialog(d1).sealed, true);
ok('appended 6 transmissions in order, then sealed');

// ---- 2. Disputed contract: -1 holds the seal; dismissal is annotated, not erased ----
console.log('2) disputed contract');
const d2 = 'dialog-0002';
myc.append(d2, { type: 'dialog_open', actorId: 'backerC', actorRole: 'plan_backer', data: { post: 'post-88' } });
myc.append(d2, { type: 'contract_created', actorId: 'backerC', actorRole: 'plan_backer', data: { amount: 500, settlement: 'tranches' } });
myc.append(d2, { type: 'ping', actorId: 'producerD', actorRole: 'plan_producer', data: { ref: 'ping-1' } });
myc.append(d2, { type: 'rating', actorId: 'backerC', actorRole: 'plan_backer', data: { rated_role: 'plan_producer', value: -1, narrative_ref: 'nar-9' } });
myc.append(d2, { type: 'audit_open', actorId: 'backerC', actorRole: 'plan_backer', data: { target: 'rating-x' } });
myc.append(d2, { type: 'audit_resolved', actorId: 'adminE', actorRole: 'adjudicator', data: { outcome: 'dismissed' } });
myc.append(d2, { type: 'rating', actorId: 'producerD', actorRole: 'plan_producer', data: { rated_role: 'plan_backer', value: 2 } });
const seal2 = myc.seal(d2);
assert.ok(seal2 && seal2.hash, 'dialog 2 sealed after audit resolved');
ok('the -1 and its dismissal are both on the sealed record (annotate, never erase)');

// ---- 3. The per-operator chain verifies ----
console.log('3) verification');
let v = myc.verify();
assert.deepStrictEqual(v, { ok: true, anchors: 2 }, 'chain verifies with 2 anchors');
ok('verify() ok, 2 anchors');

// ---- 4. Tamper detection: mutate a sealed transmission's stored bytes ----
console.log('4) tamper detection');
const victim = myc.store.log.find((r) => r.dialogId === d1 && r.type === 'escrow_settled');
victim.dataText = victim.dataText.replace('100', '9999'); // silently change the settled amount
v = myc.verify();
assert.strictEqual(v.ok, false, 'tamper is detected');
assert.match(v.broken_at, /dialog-0001/, 'tamper localized to the altered dialog');
ok(`verify() caught it: ${v.reason} @ ${v.broken_at}`);
victim.dataText = victim.dataText.replace('9999', '100'); // repair for the next step
assert.strictEqual(myc.verify().ok, true, 'repaired');

// ---- 5. Post-seal annotation: a late dismissal references the sealed dialog, never edits it ----
console.log('5) post-seal annotation');
const beforeSeq = myc.forDialog(d1).transmissions.length;
myc.record(d1, { type: 'audit_resolved', actorId: 'adminE', actorRole: 'adjudicator', data: { outcome: 'dismissed', note_ref: 'nar-late' } });
const after = myc.forDialog(d1);
assert.strictEqual(after.transmissions.length, beforeSeq + 1, 'annotation appended');
assert.ok(after.anchors.some((a) => a.kind === 'annotation'), 'annotation anchored separately');
assert.strictEqual(myc.verify().ok, true, 'chain still verifies after annotation');
ok('late dismissal recorded as a new, separately-anchored transmission');

// ---- 6. Witness checkpoint stub (SPEC §5.1 — intended, not built) ----
console.log('6) witness checkpoint (stub)');
const cp = myc.checkpoint();
assert.strictEqual(cp.witnessed, false, 'checkpoint is unwitnessed (not built)');
assert.strictEqual(typeof cp.body.tree_size, 'number', 'checkpoint has a monotonic tree_size');
ok(`checkpoint tree_size=${cp.body.tree_size}, witnessed=${cp.witnessed} (witness layer not built)`);

console.log(`\nAll ${n} checks passed.`);
