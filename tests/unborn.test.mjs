/**
 * dsh-ide-git — a repository with no commits yet.
 *
 * `git init` alone leaves HEAD UNBORN: there is no commit for it to point at, and
 * `git rev-parse --abbrev-ref HEAD` exits 128 ("ambiguous argument 'HEAD'") in
 * that state. The branch lookup used to throw on that, and because `summary` asks
 * for the branch BEFORE it reads any status, the whole panel died with it — a
 * freshly initialised workspace rendered as an error, with none of the files it
 * already contained listed anywhere.
 *
 * These tests pin the freshly-initialised case: the panel must name the unborn
 * branch, list every untracked file, and show an empty history rather than an
 * error banner. `git status` was never the problem — it answers fine without
 * commits — so the assertions are about the two calls that were.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { apply } from '../src/index.js'

let route = null
apply({
  effect: (fn) => fn(),
  webServer: { register: (spec) => { route = spec; return () => {} } },
})

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

/** A folder that has only ever seen `git init` — no commit, HEAD unborn. */
function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ide-git-unborn-'))
  made.push(dir)
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'master')
  g('config', 'core.autocrlf', 'false')
  g('config', 'user.name', 'Check')
  g('config', 'user.email', 'check@example.com')
  writeFileSync(join(dir, 'note.txt'), 'hello\n')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'deep.txt'), 'deep\n')
  return { dir, g }
}

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

test('the premise: rev-parse cannot name an unborn HEAD, symbolic-ref can', () => {
  const { dir, g } = freshRepo()
  let revParseFailed = false
  try { g('rev-parse', '--abbrev-ref', 'HEAD') } catch (error) { revParseFailed = true; void error }
  assert.equal(revParseFailed, true, 'this fixture is only meaningful while rev-parse fails here')
  assert.equal(g('symbolic-ref', '--short', 'HEAD').trim(), 'master', 'the unborn branch still has a name')
})

test('summary survives a repository with no commits', async () => {
  const { dir } = freshRepo()
  const { status, body } = await call('summary', { cwd: dir })
  assert.equal(status, 200, 'a fresh repo is not an error')
  assert.equal(body.ok, true)
  assert.equal(body.data.branch, 'master', 'the branch the first commit will create')
  assert.equal(body.data.detached, false)
})

test('files in a fresh repo are listed, not hidden behind the branch error', async () => {
  const { dir } = freshRepo()
  const { body } = await call('summary', { cwd: dir })
  const paths = body.data.changes.untracked.map((entry) => entry.path).sort()
  assert.deepEqual(paths, ['note.txt', 'sub/deep.txt'])
})

test('history of a fresh repo is empty, not an error', async () => {
  const { dir } = freshRepo()
  const { status, body } = await call('log', { cwd: dir })
  assert.equal(status, 200, 'no commits yet is an empty history')
  assert.deepEqual(body.data.commits, [])
  assert.equal(body.data.hasMore, false)
})

test('a bad revision is still a real error, not swallowed as "no commits"', async () => {
  const { dir, g } = freshRepo()
  writeFileSync(join(dir, 'note.txt'), 'hello again\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'first')
  const { status, body } = await call('log', { cwd: dir, rev: 'no-such-branch-here' })
  assert.equal(status, 409, 'only the unborn case is tolerated')
  assert.equal(body.ok, false)
})

test('after the first commit the same calls keep working', async () => {
  const { dir, g } = freshRepo()
  g('add', '-A')
  g('commit', '-q', '-m', 'first')
  const summary = await call('summary', { cwd: dir })
  assert.equal(summary.body.data.branch, 'master')
  assert.deepEqual(summary.body.data.changes.untracked, [], 'everything is committed now')
  const log = await call('log', { cwd: dir })
  assert.equal(log.body.data.commits.length, 1)
  assert.equal(log.body.data.commits[0].subject, 'first')
})
