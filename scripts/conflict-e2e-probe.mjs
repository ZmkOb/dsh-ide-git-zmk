/**
 * One-off end-to-end probe (not part of `npm test`): feed a REAL `conflict`
 * payload from a running instance into the real client-side assembler and check
 * that "take ours everywhere" / "take theirs everywhere" reproduce git's own
 * stage 2 / stage 3 bodies byte for byte.
 *
 *   node scripts/conflict-e2e-probe.mjs <payload.json>
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

function lift(name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' is gone from the client half')
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') { depth -= 1; if (depth === 0) return source.slice(start, index + 1) }
  }
  throw new Error(name + ' has unbalanced braces')
}

const { conflictFileText, conflictAllDecided } = new Function(
  lift('conflictResolutionText') + '\n' + lift('conflictFileText') + '\n' + lift('conflictAllDecided') +
  '\nreturn { conflictFileText, conflictAllDecided };',
)()

const raw = readFileSync(process.argv[2], 'utf8')
const payload = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
const data = payload.data ?? payload
const blocks = data.blocks
const conflicts = blocks.filter((block) => block.kind === 'conflict')

const choices = (choice) => Object.fromEntries(conflicts.map((c) => [c.index, choice]))
const show = (text) => JSON.stringify(text.length > 60 ? text.slice(0, 60) + '…' : text)

console.log('operation            ', data.operation, '| swapped', data.swapped)
console.log('conflict blocks      ', conflicts.length)
console.log('allDecided(empty)    ', conflictAllDecided([], {}))
console.log('allDecided(none yet) ', conflictAllDecided(conflicts, {}))
console.log('allDecided(all ours) ', conflictAllDecided(conflicts, choices('ours')))

const oursBody = conflictFileText(blocks, choices('ours'))
const theirsBody = conflictFileText(blocks, choices('theirs'))
const bothBody = conflictFileText(blocks, choices('both'))

const verdict = (label, actual, expected) => {
  const ok = actual === expected
  console.log((ok ? 'PASS ' : 'FAIL ') + label +
    ' (got ' + actual.length + ' chars, git says ' + expected.length + ')')
  if (!ok) {
    const a = actual.split('\n'); const b = expected.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) { console.log('  line ' + (i + 1) + ': got ' + show(a[i] ?? '<none>') + ' want ' + show(b[i] ?? '<none>')); break }
    }
  }
  return ok
}

const okOurs = verdict('take ours everywhere === git stage 2', oursBody, data.ours)
const okTheirs = verdict('take theirs everywhere === git stage 3', theirsBody, data.theirs)

const markerFree = !/^(<{7}|={7}|>{7})/m.test(bothBody)
console.log((markerFree ? 'PASS ' : 'FAIL ') + 'take-both body carries no conflict markers')
console.log('take-both first 3 lines:')
for (const line of bothBody.split('\n').slice(0, 3)) console.log('  |' + line)

process.exit(okOurs && okTheirs && markerFree ? 0 : 1)
