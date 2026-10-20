/**
 * dsh-ide-git — three-pane conflict resolver (host half).
 *
 * The resolver reads the three inputs out of the INDEX rather than re-parsing a
 * combined diff, so these tests build REAL conflicts with real git and check what
 * each stage actually holds. The point of the suite is not the shape of the
 * response but the two things that are easy to get wrong:
 *
 *   1. An absent stage is DATA. An add/add conflict has no base, a
 *      delete/modify conflict has no file on one side — neither is an error.
 *   2. Merge and rebase SWAP what "ours" means. A panel that prints
 *      "ours = mine" unconditionally mislabels both panes during a rebase, so
 *      `swapped` is asserted here rather than trusted.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { apply } from '../src/index.js'

let route = null
const ctx = {
  effect: (fn) => fn(),
  webServer: { register: (spec) => { route = spec; return () => {} } },
}
apply(ctx)

const made = []

function call(method, payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/dsh-ide-git/api/' + method
    req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
    req.destroy = () => {}
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status },
      end(text) {
        try { resolve({ status: this.statusCode, body: JSON.parse(text) }) } catch (error) { reject(error) }
      },
    }
    void route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(payload === undefined ? {} : payload)))
    req.emit('end')
  })
}

/** A throwaway repo whose `main` and `feature` both rewrite the same line. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ide-git-conflict-'))
  made.push(dir)
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  /* Fixture isolation, exactly as api.test.mjs does it: Git for Windows ships a
     system-level core.autocrlf=true that would rewrite the line endings we assert
     on byte-for-byte. */
  g('config', 'core.autocrlf', 'false')
  g('config', 'core.eol', 'lf')
  g('config', 'user.name', 'Check')
  g('config', 'user.email', 'check@example.com')
  writeFileSync(join(dir, 'conflict.txt'), 'base line\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'base')
  g('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'conflict.txt'), 'feature line\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'feature side')
  g('checkout', '-q', 'main')
  writeFileSync(join(dir, 'conflict.txt'), 'main line\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'main side')
  return { dir, g }
}

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function merge(g) {
  try { g('merge', '--no-edit', 'feature') } catch (error) { void error }
}

function rebase(g) {
  g('checkout', '-q', 'feature')
  try { g('rebase', 'main') } catch (error) { void error }
}

test('a merge conflict returns base / ours / theirs from the index stages', async () => {
  const { dir, g } = scratch()
  merge(g)
  const { status, body } = await call('conflict', { cwd: dir, path: 'conflict.txt' })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.data.base, 'base line\n', 'stage 1 is the common ancestor')
  assert.equal(body.data.ours, 'main line\n', 'stage 2 is the checked-out branch')
  assert.equal(body.data.theirs, 'feature line\n', 'stage 3 is the branch merged in')
  assert.equal(body.data.operation, 'merge')
  assert.equal(body.data.swapped, false)
})

test('the working-tree body still carries the markers the panel has to replace', async () => {
  const { dir, g } = scratch()
  merge(g)
  const { body } = await call('conflict', { cwd: dir, path: 'conflict.txt' })
  assert.ok(body.data.work.includes('<<<<<<<'), 'the merge file keeps its markers')
  assert.ok(body.data.work.includes('======='))
  assert.ok(body.data.work.includes('>>>>>>>'))
})

/**
 * The trap this field exists for. During a rebase git checks out the upstream
 * first and then replays your commits onto it, so stage 2 holds the OTHER side's
 * content — "ours" is no longer the branch you started on.
 */
test('a rebase reports the stages as swapped', async () => {
  const { dir, g } = scratch()
  rebase(g)
  const { body } = await call('conflict', { cwd: dir, path: 'conflict.txt' })
  assert.equal(body.data.operation, 'rebase')
  assert.equal(body.data.swapped, true, 'the panel must not label these as "mine" / "theirs"')
  // content is identical to the merge case; only its MEANING flipped
  assert.equal(body.data.ours, 'main line\n')
  assert.equal(body.data.theirs, 'feature line\n')
})

test('a cherry-pick is also swapped', async () => {
  const { dir, g } = scratch()
  /* main already carries its own "main line" change, so replaying feature's
     change on top of it collides — no reset to the base commit here, or the
     pick would apply cleanly and there would be no conflict to inspect. */
  try { g('cherry-pick', 'feature') } catch (error) { void error }
  const { body } = await call('conflict', { cwd: dir, path: 'conflict.txt' })
  assert.equal(body.data.operation, 'cherry-pick')
  assert.equal(body.data.swapped, true)
})

test('an add/add conflict has NO base — an absent stage is data, not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ide-git-conflict-addadd-'))
  made.push(dir)
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'core.autocrlf', 'false')
  g('config', 'user.name', 'Check')
  g('config', 'user.email', 'check@example.com')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'base')
  g('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'fresh.txt'), 'from feature\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'feature adds fresh')
  g('checkout', '-q', 'main')
  writeFileSync(join(dir, 'fresh.txt'), 'from main\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'main adds fresh')
  try { g('merge', '--no-edit', 'feature') } catch (error) { void error }

  const { status, body } = await call('conflict', { cwd: dir, path: 'fresh.txt' })
  assert.equal(status, 200, 'no common ancestor must not be an error')
  assert.equal(body.data.base, null, 'stage 1 is legitimately absent here')
  assert.equal(body.data.ours, 'from main\n')
  assert.equal(body.data.theirs, 'from feature\n')
})

test('resolveConflict writes the body and marks the path settled', async () => {
  const { dir, g } = scratch()
  merge(g)
  const { status, body } = await call('resolveConflict', {
    cwd: dir,
    path: 'conflict.txt',
    content: 'both sides kept\n',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(readFileSync(join(dir, 'conflict.txt'), 'utf8'), 'both sides kept\n')
  // `git add` is what ends the conflict: the path leaves the unmerged set.
  assert.equal(g('status', '--porcelain').trim(), 'M  conflict.txt', 'staged, no longer "UU"')
  assert.equal(g('diff', '--name-only', '--diff-filter=U').trim(), '', 'nothing unmerged remains')
})

test('resolveConflict refuses a body that is not a string and a path that escapes', async () => {
  const { dir, g } = scratch()
  merge(g)
  const missing = await call('resolveConflict', { cwd: dir, path: 'conflict.txt' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'bad-request')

  const escaping = await call('resolveConflict', {
    cwd: dir,
    path: '../escaped.txt',
    content: 'nope\n',
  })
  assert.equal(escaping.status, 400)
  assert.equal(escaping.body.error.code, 'bad-request')
})

test('conflict requires a path', async () => {
  const { dir, g } = scratch()
  merge(g)
  const { status, body } = await call('conflict', { cwd: dir })
  assert.equal(status, 400)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bad-request')
})

test('blocks carry both sides already split into lines', async () => {
  const { dir, g } = scratch()
  merge(g)
  const { body } = await call('conflict', { cwd: dir, path: 'conflict.txt' })
  const conflicts = body.data.blocks.filter((segment) => segment.kind === 'conflict')
  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0].ours, ['main line'])
  assert.deepEqual(conflicts[0].theirs, ['feature line'])
  assert.equal(conflicts[0].base, null, 'the two-way style records no base section')
  assert.equal(conflicts[0].index, 0)
})

test('diff3 style keeps the base section the resolver can show', async () => {
  const { dir, g } = scratch()
  g('config', 'merge.conflictStyle', 'diff3')
  merge(g)
  const { body } = await call('conflict', { cwd: dir, path: 'conflict.txt' })
  const conflict = body.data.blocks.find((segment) => segment.kind === 'conflict')
  assert.deepEqual(conflict.base, ['base line'], 'the ||||||| section is preserved')
  assert.deepEqual(conflict.ours, ['main line'])
  assert.deepEqual(conflict.theirs, ['feature line'])
})

test('text outside the conflict survives, in order', async () => {  const dir = mkdtempSync(join(tmpdir(), 'dsh-ide-git-conflict-multi-'))
  made.push(dir)
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'core.autocrlf', 'false')
  g('config', 'core.eol', 'lf')
  g('config', 'user.name', 'Check')
  g('config', 'user.email', 'check@example.com')
  writeFileSync(join(dir, 'm.txt'), 'head\nshared\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'base')
  g('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'm.txt'), 'head\nfeature\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'feature side')
  g('checkout', '-q', 'main')
  writeFileSync(join(dir, 'm.txt'), 'head\nmain\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'main side')
  try { g('merge', '--no-edit', 'feature') } catch (error) { void error }

  const { body } = await call('conflict', { cwd: dir, path: 'm.txt' })
  assert.deepEqual(
    body.data.blocks.map((segment) => segment.kind),
    ['text', 'conflict', 'text'],
    'the untouched head line stays outside the conflict',
  )
  assert.equal(body.data.blocks[0].text, 'head')
})

/** A delete/modify conflict: `feature` removes the file, `main` edits it. */
function scratchDeleteModify() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ide-git-conflict-delmod-'))
  made.push(dir)
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'core.autocrlf', 'false')
  g('config', 'core.eol', 'lf')
  g('config', 'user.name', 'Check')
  g('config', 'user.email', 'check@example.com')
  writeFileSync(join(dir, 'gone.txt'), 'one\ntwo\nthree\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'base')
  g('checkout', '-q', '-b', 'feature')
  g('rm', '-q', 'gone.txt')
  g('commit', '-q', '-m', 'feature drops gone.txt')
  g('checkout', '-q', 'main')
  writeFileSync(join(dir, 'gone.txt'), 'one\ntwo edited\nthree\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'main edits gone.txt')
  try { g('merge', '--no-edit', 'feature') } catch (error) { void error }
  return { dir, g }
}

/**
 * The case that has no blocks to pick from. Git resolves a delete/modify
 * conflict by leaving the surviving version in the tree WITHOUT markers, so the
 * pane can only offer "keep it" or "remove it" — and "remove it" is `git rm`,
 * not a body to write.
 */
test('a delete/modify conflict has no conflict blocks and one absent stage', async () => {
  const { dir } = scratchDeleteModify()
  const { status, body } = await call('conflict', { cwd: dir, path: 'gone.txt' })
  assert.equal(status, 200)
  assert.equal(body.data.theirs, null, 'the deleted side has no stage 3')
  assert.equal(body.data.ours, 'one\ntwo edited\nthree\n')
  assert.equal(
    body.data.blocks.filter((segment) => segment.kind === 'conflict').length,
    0,
    'git left no markers, so there is nothing to choose block by block',
  )
  assert.equal(body.data.work, 'one\ntwo edited\nthree\n', 'the working tree keeps the surviving side')
})

test('resolveConflict with remove settles the path by deleting it', async () => {
  const { dir, g } = scratchDeleteModify()
  assert.equal(g('status', '--porcelain').trim(), 'UD gone.txt', 'still unmerged before the call')
  const { status, body } = await call('resolveConflict', { cwd: dir, path: 'gone.txt', remove: true })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.data.removed, true)
  assert.equal(existsSync(join(dir, 'gone.txt')), false, 'the file is gone from the working tree')
  assert.equal(g('diff', '--name-only', '--diff-filter=U').trim(), '', 'nothing unmerged remains')
  assert.equal(g('status', '--porcelain').trim(), 'D  gone.txt', 'staged as a delete')
})

test('remove ignores a body and still refuses a path that escapes', async () => {
  const { dir } = scratchDeleteModify()
  const escaping = await call('resolveConflict', {
    cwd: dir,
    path: '../escaped.txt',
    remove: true,
  })
  assert.equal(escaping.status, 400)
  assert.equal(escaping.body.error.code, 'bad-request')
})

test('a plain resolveConflict reports that it did not remove anything', async () => {
  const { dir, g } = scratch()
  merge(g)
  const { body } = await call('resolveConflict', { cwd: dir, path: 'conflict.txt', content: 'x\n' })
  assert.equal(body.data.removed, false)
})
