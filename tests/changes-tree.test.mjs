/**
 * dsh-ide-git — "Group by directory" tree test.
 *
 * "Group by directory" used to be one flat row per FULL directory path, with the
 * path as the label and no nesting at all — which for a Java package chain reads
 * as one unreadable string. It now builds a real forest: a node per path segment,
 * per-node totals, and the IDE's compact-middle-packages collapse for chains of
 * single-child folders.
 *
 * The three functions are pure (they close over nothing), so they are lifted
 * straight out of the client half and driven here the same way graph.test.mjs
 * lifts buildRows — no browser, no React.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

/** Lift a `function <name>(...) {` out of the client half by brace matching. */
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
  return new Function(source.slice(start, end) + '; return ' + name + ';')()
}

const buildChangesTree = lift('buildChangesTree')
const totalChangesTree = lift('totalChangesTree')
const flattenChangesTree = lift('flattenChangesTree')

/** One git-status entry, with the stats the panel has already merged in. */
const entry = (path, additions = 0, deletions = 0) => ({ path, additions, deletions })

function flatten(entries, folded = []) {
  const forest = buildChangesTree(entries)
  totalChangesTree(forest)
  return flattenChangesTree(forest, '', 0, (id) => folded.indexOf(id) >= 0, [])
}

const dirsOf = (flat) => flat.filter((item) => item.kind === 'folder')
const rowsOf = (flat) => flat.filter((item) => item.kind === 'row')

test('a deep single-child chain collapses into ONE folder row', () => {
  const flat = flatten([
    entry('transfer-common/transfer-common-core/src/main/java/com/medicom/common/constant/Constants.java', 6, 0),
  ])
  const dirs = dirsOf(flat)
  assert.equal(dirs.length, 1, 'the whole chain is one row, not six')
  assert.equal(dirs[0].label, 'transfer-common/transfer-common-core/src/main/java/com/medicom/common/constant')
  assert.equal(dirs[0].depth, 0)
  // the file hangs one level under its folder
  const rows = rowsOf(flat)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].depth, 1)
})

test('a folder that forks stays split, and carries its subtree totals', () => {
  const flat = flatten([
    entry('transfer-common/transfer-common-core/src/main/java/com/medicom/common/constant/Constants.java', 6, 0),
    entry('transfer-common/transfer-common-core/src/main/java/com/medicom/common/utils/TransferFileUtils.java', 46, 0),
  ])
  const dirs = dirsOf(flat)
  assert.deepEqual(dirs.map((dir) => dir.label), [
    'transfer-common/transfer-common-core/src/main/java/com/medicom/common',
    'constant',
    'utils',
  ])
  assert.deepEqual(dirs.map((dir) => dir.depth), [0, 1, 1])
  const top = dirs[0].total
  assert.equal(top.count, 2)
  assert.equal(top.additions, 52)
  assert.equal(top.deletions, 0)
  // children add up to the parent's totals
  assert.equal(dirs[1].total.additions + dirs[2].total.additions, top.additions)
})

test('root-level files sit at depth 0, next to folders', () => {
  const flat = flatten([entry('pom.xml', 3, 2), entry('docs/a.md', 1, 0)])
  // Folders render before the root's own files, the same order the branch tree
  // uses — so the nested row comes first in the list even though it is deeper.
  const rows = rowsOf(flat)
  const pom = rows.find((row) => row.item.path === 'pom.xml')
  const nested = rows.find((row) => row.item.path === 'docs/a.md')
  assert.equal(pom.depth, 0, 'a repo-root file is not indented')
  assert.equal(nested.depth, 1, 'a file inside a folder is one level in')
  assert.equal(dirsOf(flat)[0].label, 'docs')
})

test('an ignored DIRECTORY entry stays a single leaf, never a bogus folder', () => {
  // `git ls-files --others --ignored --directory` reports "dist/" with a trailing
  // slash. Splitting that on '/' would make a folder named "dist" holding a
  // nameless file; it must stay one root row instead.
  const flat = flatten([entry('transfer-ui/node_modules/', 0, 0)])
  assert.equal(dirsOf(flat).length, 0, 'no folder may be grown for a trailing-slash entry')
  const rows = rowsOf(flat)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].item.path, 'transfer-ui/node_modules/')
  assert.equal(rows[0].depth, 0)
})

test('a folded folder hides exactly its own subtree', () => {
  const entries = [entry('docs/inbox/a.md', 1, 0), entry('docs/out/b.md', 2, 0)]
  const open = flatten(entries)
  const folded = flatten(entries, ['docs'])
  assert.deepEqual(dirsOf(open).map((dir) => dir.label), ['docs', 'inbox', 'out'])
  assert.deepEqual(dirsOf(folded).map((dir) => dir.label), ['docs'])
  assert.equal(rowsOf(folded).length, 0, 'both leaves live under the folded folder')
})

test('missing or zero stats never produce NaN or negative totals', () => {
  const flat = flatten([
    entry('a/b/one.txt', undefined, undefined),
    entry('a/b/two.txt', 0, 4),
  ])
  const total = dirsOf(flat)[0].total
  assert.equal(total.count, 2)
  assert.equal(total.additions, 0)
  assert.equal(total.deletions, 4)
  assert.ok(Number.isFinite(total.additions) && Number.isFinite(total.deletions))
})

/**
 * v0.5.4 near-miss, restated for this feature: GraphCell read GRAPH_MAX_LANES
 * before the constant existed in the file, and every real page died with a
 * ReferenceError that better-sidebar's error boundary swallowed — the render and
 * layout tests both passed. The tree rows compute their indent from these two
 * constants, so their presence is asserted rather than assumed.
 */
test('every constant the tree rows read is declared in the client half', () => {
  for (const name of ['CHANGES_INDENT_BASE', 'CHANGES_INDENT_STEP']) {
    assert.ok(source.includes('const ' + name + ' ='), name + ' is read but never declared')
  }
})

test('the old one-level grouping never comes back', () => {
  assert.equal(
    source.includes('folderOf'),
    false,
    'folderOf grouped by full directory path with no nesting; the tree replaced it',
  )
})
