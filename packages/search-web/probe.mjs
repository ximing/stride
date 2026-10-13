import { Worker } from 'node:worker_threads'
globalThis.Worker = Worker
const { createVane } = await import('@vane-rs/web')
const timer = setTimeout(() => {
  console.error('PROBE_TIMEOUT')
  process.exit(2)
}, 15000)
try {
  const vane = await createVane({ vfs: 'memory', dbPath: 'probe.db', dictData: new Uint8Array([0]) })
  console.log('created')
  await vane.open('probe.db', { autoCommit: 'off', persistence: 'persistent' })
  console.log('opened')
  const col = await vane.collection('notes', { fields: [{ name: 'text', type: 'text' }] }, { tokenizer: 'jieba', autoCommit: 'off' })
  console.log('col', col)
  await vane.add(col, [
    { id: 'moss', text: '森林地面长满了苔藓和蕨类植物' },
    { id: 'alpha', text: 'p'.repeat(30) + 'xylophonequartz' + 's'.repeat(30) },
  ])
  await vane.flush(col)
  const hits = await vane.search(col, { text: '苔藓', topK: 5, mode: 'text' })
  console.log('HITS', JSON.stringify(hits))
  const hits2 = await vane.search(col, { text: 'xylophonequartz', topK: 5, mode: 'text' })
  console.log('HITS2', JSON.stringify(hits2))
  await vane.close()
  console.log('closed')
} catch (error) {
  console.error('PROBE_ERROR', error && error.stack ? error.stack : error)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
}
