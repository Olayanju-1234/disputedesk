import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeTimeLeft, nextAlert } from '../src/domain/deadline';

const DUE = '2020-11-25T18:00:00.000Z';
const at = (hoursBeforeDue: number) => new Date(Date.parse(DUE) - hoursBeforeDue * 3_600_000);

describe('nextAlert', () => {
  it('stays quiet while more than 8 hours are left', () => {
    assert.equal(nextAlert(DUE, [], at(9)), null);
  });

  it('fires the 8 hour alert at medium priority', () => {
    const alert = nextAlert(DUE, [], at(7.5));
    assert.equal(alert?.thresholdHours, 8);
    assert.equal(alert?.priority, 'Medium');
    assert.deepEqual(alert?.covers, [8]);
  });

  it('does not repeat a threshold already sent', () => {
    assert.equal(nextAlert(DUE, [8], at(7)), null);
    assert.equal(nextAlert(DUE, [8], at(3.9))?.thresholdHours, 4);
  });

  it('jumps straight to the most urgent threshold when the sweep is late', () => {
    const alert = nextAlert(DUE, [], at(0.5));
    assert.equal(alert?.thresholdHours, 1);
    assert.equal(alert?.priority, 'Highest');
    assert.deepEqual(alert?.covers, [8, 4, 1]);
  });

  it('fires an overdue alert once the deadline passes', () => {
    const alert = nextAlert(DUE, [8, 4, 1], at(-0.2));
    assert.equal(alert?.thresholdHours, 0);
    assert.equal(nextAlert(DUE, [8, 4, 1, 0], at(-5)), null);
  });

  it('ignores disputes without a usable due date', () => {
    assert.equal(nextAlert(null, [], at(0)), null);
    assert.equal(nextAlert('not-a-date', [], at(0)), null);
  });
});

describe('describeTimeLeft', () => {
  it('formats hours, minutes and overdue time', () => {
    assert.equal(describeTimeLeft(5.25), '5.3 h left');
    assert.equal(describeTimeLeft(0.5), '30 min left');
    assert.equal(describeTimeLeft(-0.25), 'overdue by 15 min');
    assert.equal(describeTimeLeft(-2), 'overdue by 2.0 h');
  });
});
