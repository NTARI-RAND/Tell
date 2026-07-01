/**
 * Mycelium — reference implementation (P3-013).
 *
 * The per-operator, witnessed, append-only record layer for Janus-Facing
 * Architecture networks. This file is the canonical *reference* implementation:
 * storage-agnostic, dependency-light, and written to be read. It tracks SPEC.md
 * clause-for-clause; where the two disagree, the spec wins.
 *
 * Two append-only hash chains (SPEC §3, §5):
 *   - intra-dialog: each transmission folds into a running head hash, so an open
 *     dialog is tamper-evident as it is built —  h_0 = H(C_0), h_i = H(h_{i-1} ‖ C_i)
 *   - per-operator: sealed dialogs (and post-seal annotations) chain within THIS
 *     operator's log —  anchor.hash = H(prev_anchor.hash ‖ canonical(anchor))
 *
 * One Mycelium instance == one operator's log (SPEC §5: there is no global chain
 * and no consensus). Cross-operator non-equivocation comes from witnessing
 * (SPEC §5.1) — signed, monotonic checkpoints to independent witnesses — which is
 * INTENDED, NOT BUILT here; see `checkpoint()`.
 *
 * Only references and structural facts are ever hashed — never PII (SPEC §6).
 *
 * Copyright (C) 2026 Network Theory Applied Research Institute
 * Licensed under the GNU Affero General Public License v3.0.
 */

'use strict';

const nodeCrypto = require('crypto');

const SPEC_VERSION = '0.3';

/** Default hash: SHA-256 hex. Algorithm-agile — inject your own to upgrade (SPEC §3). */
const sha256Hex = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

/** Canonical bytes of one transmission (header-led; refs only — never PII). SPEC §2, §6. */
function txnCore({ dialogId, seq, type, actorId, actorRole, dataText }) {
  return `${dialogId}|${seq}|${type}|${actorId || ''}|${actorRole || ''}|${dataText || ''}`;
}

/** Canonical bytes of one anchor. Bound to the operator so logs cannot be spliced. SPEC §5. */
function anchorCore({ operatorId, kind, dialogId, fileHash, sealedSeq }) {
  return `${operatorId}|${kind}|${dialogId}|${fileHash}|${sealedSeq}`;
}

function stableStringify(data) {
  if (data === null || typeof data !== 'object') return JSON.stringify(data);
  if (Array.isArray(data)) return `[${data.map(stableStringify).join(',')}]`;
  const keys = Object.keys(data).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(data[k])}`).join(',')}}`;
}

/**
 * In-memory append-only store. Swap for a durable one (SQL, KV, files) by
 * implementing the same nine methods; all are append-only or read — never update
 * or delete (SPEC §5, "there is no update and no delete").
 */
class InMemoryStore {
  constructor() {
    this.log = [];      // transmissions:  { dialogId, seq, type, actorId, actorRole, dataText, head, at }
    this.anchors = [];  // anchors (this operator): { n, operatorId, dialogId, kind, fileHash, sealedSeq, prevHash, hash, at }
  }
  appendTransmission(row) { this.log.push({ ...row, at: row.at }); }
  dialogTail(dialogId) {
    const rows = this.log.filter((r) => r.dialogId === dialogId);
    return rows.length ? rows[rows.length - 1] : null;
  }
  dialogTransmissions(dialogId, uptoSeq = Infinity) {
    return this.log
      .filter((r) => r.dialogId === dialogId && r.seq <= uptoSeq)
      .sort((a, b) => a.seq - b.seq);
  }
  appendAnchor(row) { this.anchors.push({ ...row, n: this.anchors.length + 1 }); }
  anchorTail(operatorId) {
    const rows = this.anchors.filter((a) => a.operatorId === operatorId);
    return rows.length ? rows[rows.length - 1] : null;
  }
  anchorsFor(operatorId) {
    return this.anchors.filter((a) => a.operatorId === operatorId).sort((a, b) => a.n - b.n);
  }
  dialogAnchors(operatorId, dialogId) {
    return this.anchorsFor(operatorId).filter((a) => a.dialogId === dialogId);
  }
  hasSeal(operatorId, dialogId) {
    return this.anchorsFor(operatorId).some((a) => a.dialogId === dialogId && a.kind === 'seal');
  }
}

class Mycelium {
  /**
   * @param {object} opts
   * @param {string} opts.operatorId  This operator's id. One instance == one log (SPEC §5).
   * @param {object} [opts.store]     Append-only store (default: InMemoryStore).
   * @param {(s:string)=>string} [opts.hash]  Hash function (default: SHA-256 hex).
   * @param {()=>number} [opts.now]   Clock (default: Date.now) — injectable for tests.
   * @param {(bytes:string)=>string} [opts.sign]  Operator signer for checkpoints (optional; witnessing not built).
   */
  constructor({ operatorId, store = new InMemoryStore(), hash = sha256Hex, now = () => Date.now(), sign = null } = {}) {
    if (!operatorId) throw new Error('Mycelium: operatorId is required (each operator keeps its own log — SPEC §5).');
    this.operatorId = operatorId;
    this.store = store;
    this.H = hash;
    this.now = now;
    this._sign = sign;
  }

  /**
   * Append a transmission to a dialog's OPEN file (SPEC §3). Returns { seq, head }.
   * `data` MUST contain references only — never free text or PII (SPEC §6).
   */
  append(dialogId, { type, actorId = null, actorRole = null, data = {} } = {}) {
    if (this.store.hasSeal(this.operatorId, dialogId)) {
      throw new Error(`Mycelium: dialog ${dialogId} is sealed; use annotate()/record() (SPEC §7).`);
    }
    const dataText = stableStringify(data);
    const tail = this.store.dialogTail(dialogId);
    const seq = tail ? tail.seq + 1 : 0;
    const prevHead = tail ? tail.head : null;
    const head = this.H((prevHead || '') + txnCore({ dialogId, seq, type, actorId, actorRole, dataText }));
    this.store.appendTransmission({ dialogId, seq, type, actorId, actorRole, dataText, head, at: this.now() });
    return { seq, head };
  }

  isSealed(dialogId) { return this.store.hasSeal(this.operatorId, dialogId); }

  /** Anchor the dialog's current head on THIS operator's chain (SPEC §5). */
  _writeAnchor(dialogId, kind) {
    const tail = this.store.dialogTail(dialogId);
    if (!tail) return null;
    const fileHash = tail.head;
    const sealedSeq = tail.seq;
    const gtail = this.store.anchorTail(this.operatorId);
    const prevHash = gtail ? gtail.hash : null;
    const hash = this.H((prevHash || '') + anchorCore({ operatorId: this.operatorId, kind, dialogId, fileHash, sealedSeq }));
    this.store.appendAnchor({ operatorId: this.operatorId, dialogId, kind, fileHash, sealedSeq, prevHash, hash, at: this.now() });
    return { kind, file_hash: fileHash, hash, sealed_seq: sealedSeq };
  }

  /**
   * Seal a COMPLETE and QUIESCENT dialog (SPEC §4). Completeness/quiescence is the
   * caller's decision (it depends on ratings and open audits — see the Agrinet
   * protocol, P3-012 §4.4); Mycelium fixes the file hash and anchors it. Idempotent.
   */
  seal(dialogId) {
    if (this.isSealed(dialogId)) return { already: true };
    return this._writeAnchor(dialogId, 'seal');
  }

  /** Post-seal annotation: append, then anchor referencing the sealed dialog — never edit it (SPEC §7). */
  annotate(dialogId, transmission) {
    if (!this.isSealed(dialogId)) throw new Error(`Mycelium: dialog ${dialogId} is not sealed; use append().`);
    // annotate bypasses the sealed-guard in append() deliberately (it adds to the tail, then re-anchors)
    const dataText = stableStringify(transmission.data || {});
    const tail = this.store.dialogTail(dialogId);
    const seq = tail ? tail.seq + 1 : 0;
    const prevHead = tail ? tail.head : null;
    const head = this.H((prevHead || '') + txnCore({
      dialogId, seq, type: transmission.type,
      actorId: transmission.actorId || null, actorRole: transmission.actorRole || null, dataText,
    }));
    this.store.appendTransmission({
      dialogId, seq, type: transmission.type,
      actorId: transmission.actorId || null, actorRole: transmission.actorRole || null,
      dataText, head, at: this.now(),
    });
    return this._writeAnchor(dialogId, 'annotation');
  }

  /** Append while open; once sealed, record as a post-seal annotation (SPEC §7). */
  record(dialogId, transmission) {
    if (this.isSealed(dialogId)) return this.annotate(dialogId, transmission);
    this.append(dialogId, transmission);
    return { appended: true };
  }

  /**
   * Verify THIS operator's log (SPEC §8): every anchor links and hashes correctly,
   * and each anchor's file_hash equals the recomputed intra-dialog head at sealed_seq.
   * Returns { ok, anchors } or { ok:false, broken_at, reason }.
   */
  verify() {
    const anchors = this.store.anchorsFor(this.operatorId);
    let prev = null;
    for (const a of anchors) {
      if ((a.prevHash || null) !== prev) return { ok: false, broken_at: `anchor ${a.n}`, reason: 'anchor linkage broken' };
      const expected = this.H((prev || '') + anchorCore({
        operatorId: this.operatorId, kind: a.kind, dialogId: a.dialogId, fileHash: a.fileHash, sealedSeq: a.sealedSeq,
      }));
      if (a.hash !== expected) return { ok: false, broken_at: `anchor ${a.n}`, reason: 'anchor hash mismatch' };

      let h = null;
      for (const r of this.store.dialogTransmissions(a.dialogId, a.sealedSeq)) {
        h = this.H((h || '') + txnCore(r));
        if (r.head !== h) return { ok: false, broken_at: `${a.dialogId} seq ${r.seq}`, reason: 'dialog transmission altered' };
      }
      if (h !== a.fileHash) return { ok: false, broken_at: `anchor ${a.n}`, reason: 'file_hash does not match dialog' };
      prev = a.hash;
    }
    return { ok: true, anchors: anchors.length };
  }

  /** The full record for one dialog: transmissions + anchors + sealed flag. */
  forDialog(dialogId) {
    const transmissions = this.store.dialogTransmissions(dialogId).map((r) => ({
      seq: r.seq, type: r.type, actor_id: r.actorId, actor_role: r.actorRole,
      data: safeParse(r.dataText), head: r.head, at: r.at,
    }));
    const anchors = this.store.dialogAnchors(this.operatorId, dialogId).map((a) => ({
      kind: a.kind, file_hash: a.fileHash, sealed_seq: a.sealedSeq, hash: a.hash, at: a.at,
    }));
    return { transmissions, anchors, sealed: anchors.some((a) => a.kind === 'seal') };
  }

  listAnchors(limit = 50) {
    return this.store.anchorsFor(this.operatorId).slice(-limit).reverse().map((a) => ({
      n: a.n, dialog_id: a.dialogId, kind: a.kind, file_hash: a.fileHash, hash: a.hash, at: a.at,
    }));
  }

  /**
   * Produce a signed, monotonic checkpoint of this operator's log head — the unit an
   * independent witness co-signs so equivocation becomes self-evident (SPEC §5.1,
   * Certificate Transparency / RFC 6962).
   *
   * STATUS: INTENDED, NOT BUILT. This returns the checkpoint *body* only. Witnessing
   * proper — signing the body with the operator key, publishing to >= 1 independent
   * witness, obtaining a signed witness receipt, and serving inclusion proofs on read —
   * is the highest-leverage federation step and is not implemented here. Until it
   * exists, non-equivocation rests on there being a single backend (SPEC §5.1).
   */
  checkpoint() {
    const anchors = this.store.anchorsFor(this.operatorId);
    const tail = anchors.length ? anchors[anchors.length - 1] : null;
    const body = {
      operator_id: this.operatorId,
      tree_size: anchors.length,      // monotonic: only ever grows
      head_hash: tail ? tail.hash : null,
      spec_version: SPEC_VERSION,
      ts: this.now(),
    };
    const signature = this._sign ? this._sign(stableStringify(body)) : null;
    return {
      body,
      signature,                      // null until an operator signer is wired
      witnessed: false,               // no witness receipt — witnessing not built (SPEC §5.1)
    };
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

module.exports = {
  Mycelium,
  InMemoryStore,
  SPEC_VERSION,
  // exported for reuse / conformance tests:
  sha256Hex,
  txnCore,
  anchorCore,
  stableStringify,
};
