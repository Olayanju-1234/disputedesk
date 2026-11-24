import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyReason,
  evidenceChecklist,
  evidenceProgress,
  toggleEvidence,
} from '../src/domain/evidence';

describe('classifyReason', () => {
  it('treats the fraud category as a fraud claim whatever the message', () => {
    assert.equal(classifyReason({ category: 'fraud', customerMessage: 'debited twice' }), 'fraud');
  });

  it('reads the reason from the customer message on chargebacks', () => {
    const c = (customerMessage: string) =>
      classifyReason({ category: 'chargeback', customerMessage });
    assert.equal(c('Customer complained about debit without value'), 'not-received');
    assert.equal(c('Customer says the order never arrived'), 'not-received');
    assert.equal(c('I was debited twice for one order'), 'duplicate');
    assert.equal(c('Cardholder does not recognise this charge'), 'not-recognised');
    assert.equal(c('Something else entirely'), 'other');
  });

  it('falls back to other when there is no message', () => {
    assert.equal(classifyReason({ category: 'chargeback', customerMessage: null }), 'other');
  });
});

describe('evidence checklist', () => {
  it('always starts with the transaction receipt', () => {
    for (const reason of [
      'not-received',
      'not-recognised',
      'duplicate',
      'fraud',
      'other',
    ] as const) {
      assert.equal(evidenceChecklist(reason)[0]?.id, 'receipt', reason);
    }
  });

  it('asks fraud claims for customer and delivery details', () => {
    const ids = evidenceChecklist('fraud').map((i) => i.id);
    assert.ok(ids.includes('customer-details'));
    assert.ok(ids.includes('delivery-details'));
  });

  it('has unique item ids in every list', () => {
    for (const reason of [
      'not-received',
      'not-recognised',
      'duplicate',
      'fraud',
      'other',
    ] as const) {
      const ids = evidenceChecklist(reason).map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, reason);
    }
  });

  it('tracks progress as items are ticked and unticked', () => {
    const items = evidenceChecklist('not-received');
    let state = toggleEvidence(items, {}, 'receipt', true, 'acc-1', '2026-11-24T10:00:00Z');
    state = toggleEvidence(
      items,
      state,
      'proof-of-delivery',
      true,
      'acc-1',
      '2026-11-24T10:01:00Z',
    );
    assert.deepEqual(evidenceProgress(items, state), { done: 2, total: 4 });
    state = toggleEvidence(items, state, 'receipt', false, 'acc-2', '2026-11-24T10:02:00Z');
    assert.deepEqual(evidenceProgress(items, state), { done: 1, total: 4 });
    assert.equal(state.receipt?.by, 'acc-2');
  });

  it('rejects ids that are not on this checklist', () => {
    assert.throws(() =>
      toggleEvidence(evidenceChecklist('duplicate'), {}, 'past-orders', true, null, 'now'),
    );
  });
});
