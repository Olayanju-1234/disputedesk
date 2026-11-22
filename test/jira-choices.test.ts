import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickPriority, pickTransition, type TransitionOption } from '../src/domain/jira-choices';

const jsmFromToDo: TransitionOption[] = [
  {
    id: '11',
    name: 'Start work',
    to: { name: 'In progress', statusCategory: { key: 'indeterminate' } },
  },
  {
    id: '21',
    name: 'In review',
    to: { name: 'In review', statusCategory: { key: 'indeterminate' } },
  },
];

describe('pickTransition', () => {
  it('prefers a transition whose name or target matches, in target order', () => {
    const options: TransitionOption[] = [
      ...jsmFromToDo,
      { id: '31', name: 'Close', to: { name: 'Done', statusCategory: { key: 'done' } } },
      { id: '41', name: 'Mark won', to: { name: 'Won', statusCategory: { key: 'done' } } },
    ];
    assert.equal(pickTransition(options, ['Won', 'Done'])?.id, '41');
    assert.equal(pickTransition(options, ['Done'])?.id, '31');
  });

  it('falls back to any transition into a done-category status', () => {
    const options: TransitionOption[] = [
      ...jsmFromToDo,
      {
        id: '51',
        name: 'Resolve this',
        to: { name: 'Completed', statusCategory: { key: 'done' } },
      },
    ];
    assert.equal(pickTransition(options, ['Won', 'Resolved'])?.id, '51');
  });

  it('returns null when the workflow has no path to done from here', () => {
    assert.equal(pickTransition(jsmFromToDo, ['Won', 'Done']), null);
  });
});

describe('pickPriority', () => {
  it('uses standard Jira names when present', () => {
    const standard = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
    assert.equal(pickPriority(standard, 'Highest'), 'Highest');
    assert.equal(pickPriority(standard, 'Medium'), 'Medium');
  });

  it('maps onto JSM-style names', () => {
    const jsm = ['Critical', 'High', 'Medium', 'Low'];
    assert.equal(pickPriority(jsm, 'Highest'), 'Critical');
    assert.equal(pickPriority(jsm, 'High'), 'High');
  });

  it('falls back to rank for unfamiliar names', () => {
    const custom = ['Sev 1', 'Sev 2', 'Sev 3', 'Sev 4'];
    assert.equal(pickPriority(custom, 'Highest'), 'Sev 1');
    assert.equal(pickPriority(custom, 'High'), 'Sev 2');
    assert.equal(pickPriority(custom, 'Medium'), 'Sev 3');
    assert.equal(pickPriority(['Only'], 'Medium'), 'Only');
    assert.equal(pickPriority([], 'High'), null);
  });
});
