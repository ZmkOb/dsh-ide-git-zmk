/**
 * dsh-ide-git — three-pane conflict resolver (client half, pure logic).
 *
 * The resolver's job is to turn "one choice per conflict block" into the exact
 * bytes that get written back. That assembly is the part worth testing without a
 * browser: a wrong join loses a newline, a wrong order drops a section, and an
 * undecided conflict that still contributes text would let a half-merged file be
 * saved — which is how a conflict gets marked resolved while still containing
 * markers.
 *
 * The three functions close over nothing, so they are lifted out of the client
 * half and driven here the same way graph.test.mjs lifts buildRows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

function lift(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, name + ' is gone from the client half')
  let depth = 0
  let end = -1
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) { end = index + 1; break }
    }
  }
  assert.ok(end > start, name + ' has unbalanced braces')
  return source.slice(start, end)
}

/* All of them share one scope: conflictFileText calls conflictResolutionText,
   and conflictCanSave calls conflictAllDecided. */
const lib = new Function(
  lift('conflictResolutionText') + '\n' +
  lift('conflictFileText') + '\n' +
  lift('conflictAllDecided') + '\n' +
  lift('conflictCanSave') +
  '\nreturn { conflictResolutionText, conflictFileText, conflictAllDecided, conflictCanSave };',
)()

const { conflictResolutionText, conflictFileText, conflictAllDecided, conflictCanSave } = lib

const conflict = (index, ours, theirs, base = null) => ({ kind: 'conflict', index, ours, theirs, base })
const text = (value) => ({ kind: 'text', text: value })

test('an undecided conflict contributes nothing at all', () => {
  assert.equal(conflictResolutionText(conflict(0, ['a'], ['b']), undefined), null)
  assert.equal(conflictResolutionText(conflict(0, ['a'], ['b']), 'nonsense'), null)
})

test('each choice yields exactly that side', () => {
  const block = conflict(0, ['ours line'], ['theirs line'])
  assert.equal(conflictResolutionText(block, 'ours'), 'ours line')
  assert.equal(conflictResolutionText(block, 'theirs'), 'theirs line')
  assert.equal(conflictResolutionText(block, 'both'), 'ours line\ntheirs line')
})

test('"both" does not emit a stray blank line when one side is empty', () => {
  // A delete/modify conflict legitimately has an empty side.
  assert.equal(conflictResolutionText(conflict(0, ['kept'], []), 'both'), 'kept')
  assert.equal(conflictResolutionText(conflict(0, [], ['added']), 'both'), 'added')
  assert.equal(conflictResolutionText(conflict(0, [], []), 'both'), '')
})

test('multi-line sides keep their internal newlines', () => {
  const block = conflict(0, ['o1', 'o2'], ['t1', 't2', 't3'])
  assert.equal(conflictResolutionText(block, 'ours'), 'o1\no2')
  assert.equal(conflictResolutionText(block, 'theirs'), 't1\nt2\nt3')
  assert.equal(conflictResolutionText(block, 'both'), 'o1\no2\nt1\nt2\nt3')
})

test('the file body keeps the surrounding text in order', () => {
  const blocks = [
    text('before'),
    conflict(0, ['ours'], ['theirs']),
    text('after'),
  ]
  assert.equal(conflictFileText(blocks, { 0: 'ours' }), 'before\nours\nafter')
  assert.equal(conflictFileText(blocks, { 0: 'theirs' }), 'before\ntheirs\nafter')
})

test('several conflicts each take their own choice', () => {
  const blocks = [
    conflict(0, ['A-ours'], ['A-theirs']),
    text('middle'),
    conflict(1, ['B-ours'], ['B-theirs']),
  ]
  assert.equal(conflictFileText(blocks, { 0: 'ours', 1: 'theirs' }), 'A-ours\nmiddle\nB-theirs')
  assert.equal(conflictFileText(blocks, { 0: 'both', 1: 'both' }), 'A-ours\nA-theirs\nmiddle\nB-ours\nB-theirs')
})

test('no conflict markers can survive into the assembled body', () => {
  // The blocks never contain the markers themselves — the host parsed them away —
  // so the joined result must not reintroduce them.
  const blocks = [text('x'), conflict(0, ['left'], ['right']), text('y')]
  for (const choice of ['ours', 'theirs', 'both']) {
    const body = conflictFileText(blocks, { 0: choice })
    assert.equal(body.includes('<<<<<<<'), false)
    assert.equal(body.includes('======='), false)
    assert.equal(body.includes('>>>>>>>'), false)
  }
})

test('conflictAllDecided is false until EVERY conflict is decided', () => {
  const conflicts = [conflict(0, ['a'], ['b']), conflict(1, ['c'], ['d'])]
  assert.equal(conflictAllDecided(conflicts, {}), false)
  assert.equal(conflictAllDecided(conflicts, { 0: 'ours' }), false, 'one of two is not enough')
  assert.equal(conflictAllDecided(conflicts, { 0: 'ours', 1: 'theirs' }), true)
})

test('conflictAllDecided refuses an empty conflict list', () => {
  // No conflicts means there is nothing to resolve — saving must stay blocked
  // rather than writing an untouched body and claiming the conflict is settled.
  assert.equal(conflictAllDecided([], {}), false)
})

/* ---- the save gate (conflictCanSave) ---- */

test('the save gate follows the block choices for an ordinary conflict', () => {
  const blocks = [text('head'), conflict(0, ['a'], ['b']), conflict(1, ['c'], ['d'])]
  const data = { truncated: false, work: 'whatever' }
  assert.equal(conflictCanSave(data, blocks, {}), false)
  assert.equal(conflictCanSave(data, blocks, { 0: 'ours' }), false)
  assert.equal(conflictCanSave(data, blocks, { 0: 'ours', 1: 'theirs' }), true)
})

test('a delete/modify path can be kept, because the tree still holds the file', () => {
  // No markers, so no blocks — but "keep the file" is a real answer: write the
  // body that is already there and stage it.
  const blocks = [text('one\ntwo edited\nthree\n')]
  assert.equal(conflictCanSave({ work: 'one\ntwo edited\nthree\n', truncated: false }, blocks, {}), true)
  // …and there is no answer at all when the tree no longer has the file: only
  // "remove it" exists, and that is a different call.
  assert.equal(conflictCanSave({ work: null, truncated: false }, blocks, {}), false)
})

test('a truncated read can never be written back', () => {
  // The host caps what it reads; writing that back would silently cut the file,
  // so even a fully-decided conflict stays unsaveable.
  const blocks = [conflict(0, ['a'], ['b'])]
  assert.equal(conflictCanSave({ truncated: true, work: 'x' }, blocks, { 0: 'ours' }), false)
  assert.equal(conflictCanSave({ truncated: true, work: 'x' }, [text('x')], {}), false)
})

test('the save gate refuses a missing payload instead of throwing', () => {
  assert.equal(conflictCanSave(null, [conflict(0, ['a'], ['b'])], { 0: 'ours' }), false)
  assert.equal(conflictCanSave(undefined, [], {}), false)
})
