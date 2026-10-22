import { observer, useService } from '@rabjs/react'
import {
  tokenUsageByModel,
  tokenUsageByMonth,
  tokenUsageByWeek,
  tokenUsageModelsInPeriod,
} from '@stride/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsService } from '../../../services/settings/settings.service'
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs'
import './token-usage.css'

type UsageGrain = 'model' | 'week' | 'month'

function formatTokens(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value)
}

export const TokenUsagePanel = observer(function TokenUsagePanel() {
  const { t, i18n } = useTranslation()
  const settings = useService(SettingsService)
  const [grain, setGrain] = useState<UsageGrain>('model')
  const [picked, setPicked] = useState('')
  const history = settings.tokenHistory
  const models = tokenUsageByModel(history)
  const periods = grain === 'week' ? tokenUsageByWeek(history) : grain === 'month' ? tokenUsageByMonth(history) : []
  const selected = periods.some((row) => row.period === picked) ? picked : periods[periods.length - 1]?.period ?? ''
  const rows = grain === 'model' ? models : tokenUsageModelsInPeriod(history, grain, selected)
  const total = models.reduce((sum, row) => sum + row.total, 0)
  const requests = models.reduce((sum, row) => sum + row.requests, 0)
  const peak = periods.reduce((max, row) => Math.max(max, row.total), 0)

  return (
    <section className="settings-usage" data-testid="token-usage" aria-label={t('settings.ai.usage')}>
      <h3 className="settings-usage-title">{t('settings.ai.usage')}</h3>
      <p className="settings-ai-meta">{settings.usageVaultOpen ? t('settings.ai.usageHint') : t('settings.ai.usageClosed')}</p>
      {models.length === 0 ? (
        settings.usageVaultOpen ? (
          <p className="settings-usage-empty" data-testid="token-usage-empty">{t('settings.ai.usageEmpty')}</p>
        ) : null
      ) : (
        <>
          <p className="settings-usage-summary" data-testid="token-usage-summary">
            {t('settings.ai.usageSummary', {
              total: formatTokens(total, i18n.language),
              requests: formatTokens(requests, i18n.language),
            })}
          </p>
          <Tabs value={grain} onValueChange={(value) => setGrain(value as UsageGrain)}>
            <TabsList aria-label={t('settings.ai.usage')}>
              <TabsTrigger value="model" data-testid="token-usage-grain-model">{t('settings.ai.usageModel')}</TabsTrigger>
              <TabsTrigger value="week" data-testid="token-usage-grain-week">{t('settings.ai.usageWeek')}</TabsTrigger>
              <TabsTrigger value="month" data-testid="token-usage-grain-month">{t('settings.ai.usageMonth')}</TabsTrigger>
            </TabsList>
          </Tabs>
          {grain !== 'model' ? (
            <div className="settings-usage-trend" data-testid="token-usage-trend-list" role="list" aria-label={t('settings.ai.usageTrend')}>
              {periods.map((row) => (
                <button
                  key={row.period}
                  type="button"
                  className="settings-usage-trend-row"
                  data-testid="token-usage-trend"
                  data-period={row.period}
                  aria-pressed={row.period === selected}
                  onClick={() => setPicked(row.period)}
                >
                  <span className="settings-usage-trend-label">{row.period}</span>
                  <span className="settings-usage-trend-bar" aria-hidden="true">
                    <span style={{ width: `${peak > 0 ? (row.total / peak) * 100 : 0}%` }} />
                  </span>
                  <span className="settings-usage-trend-value">{formatTokens(row.total, i18n.language)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {grain !== 'model' ? (
            <p className="settings-usage-period" data-testid="token-usage-period">{selected}</p>
          ) : null}
          <table className="settings-usage-table">
            <thead>
              <tr>
                <th scope="col">{t('settings.ai.model')}</th>
                <th scope="col">{t('settings.ai.usageInput')}</th>
                <th scope="col">{t('settings.ai.usageOutput')}</th>
                <th scope="col">{t('settings.ai.usageTotal')}</th>
                <th scope="col">{t('settings.ai.usageRequests')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model} data-testid="token-usage-row" data-model={row.model}>
                  <th scope="row" title={row.model}>{row.model}</th>
                  <td>{formatTokens(row.input, i18n.language)}</td>
                  <td>{formatTokens(row.output, i18n.language)}</td>
                  <td>{formatTokens(row.total, i18n.language)}</td>
                  <td>{formatTokens(row.requests, i18n.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
})
