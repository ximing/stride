import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { commitGatePrompt, isCommitGateOutput, startCommitGateFix } from './commit-gate'

const SAMPLE = [
  'ERROR agents/review/智能客服整体复盘.stride.json: 缺少必填字段: status',
  'ERROR agents/review/智能客服整体复盘.stride.json: 缺少必填字段: domain',
  'ERROR agents/review/智能客服整体复盘.stride.json: 缺少必填字段: subdomain',
  "WARN agents/review/Agent系统的成本与延迟怎么度量和优化.stride.json: related 非对称: '智能客服整体复盘' 未把 'Agent系统的成本与延迟怎么度量和优化' 列入 related",
  '3 error(s), 1 warning(s)',
].join('\n')

describe('commit gate output', () => {
  it('recognizes a note check and a hook failure', () => {
    expect(isCommitGateOutput(SAMPLE)).toBe(true)
    expect(isCommitGateOutput('husky - pre-commit script failed (code 1)')).toBe(true)
    expect(isCommitGateOutput('lefthook: commit-msg hook exited')).toBe(true)
  })

  it('ignores transport and setup errors', () => {
    expect(isCommitGateOutput('')).toBe(false)
    expect(isCommitGateOutput('network down')).toBe(false)
    expect(isCommitGateOutput('Git is turned off.')).toBe(false)
    expect(isCommitGateOutput('Commit local changes before pulling')).toBe(false)
    expect(isCommitGateOutput('Another Git write is still in progress.')).toBe(false)
    expect(isCommitGateOutput('error: failed to push some refs')).toBe(false)
  })

  it('asks the agent to edit notes or fix a hook and includes the checker output', async () => {
    await i18n.changeLanguage('en')
    const prompt = commitGatePrompt(SAMPLE)
    expect(prompt).toContain('Do not commit or push')
    expect(prompt).toContain('bash')
    expect(prompt).toContain('缺少必填字段: status')
    expect(prompt).toContain('3 error(s), 1 warning(s)')
    await i18n.changeLanguage('zh')
    const zh = commitGatePrompt('ERROR a.stride.json: 缺少必填字段: status')
    expect(zh).toContain('不要提交或推送')
    expect(zh).toContain('bash')
    await i18n.changeLanguage('en')
  })

  it('opens chat and sends only for a gate', async () => {
    const asks: string[] = []
    let opened = 0
    startCommitGateFix(SAMPLE, {
      running: false,
      ask: (text) => { asks.push(text) },
      openChat: () => { opened += 1 },
    })
    expect(opened).toBe(1)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toContain('缺少必填字段: domain')

    startCommitGateFix('network down', {
      running: false,
      ask: () => { throw new Error('should not ask') },
      openChat: () => { throw new Error('should not open') },
    })
    startCommitGateFix(SAMPLE, {
      running: true,
      ask: () => { throw new Error('should not ask') },
      openChat: () => { throw new Error('should not open') },
    })
    expect(asks).toHaveLength(1)
  })
})
