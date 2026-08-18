// src/types/context-audit.ts
import type { DateRange } from './common'

export type ContextAuditMetric =
  | 'cost_breakdown'
  | 'cache_analysis'
  | 'collapse_analysis'

export type ContextAuditDetail = 'summary' | 'full'
export type TemporalGrouping = 'day' | 'week' | 'month'

export interface ContextAuditFilters {
  readonly projectSlug?: string | undefined
  readonly dateRange?: DateRange | undefined
  readonly minTokens?: number | undefined
  readonly maxTokens?: number | undefined
  readonly minCost?: number | undefined
  readonly maxCost?: number | undefined
  readonly minCacheHitRatio?: number | undefined
  readonly maxCacheHitRatio?: number | undefined
  readonly modelFilter?: string | undefined
}

export interface ContextAuditOptions {
  readonly metric: ContextAuditMetric
  readonly detail: ContextAuditDetail
  readonly groupBy?: TemporalGrouping | undefined
  readonly filters?: ContextAuditFilters | undefined
  readonly limit?: number | undefined
}

// Result types per metric

export interface SessionRef {
  readonly id: string
  readonly topic: string | null
  readonly costUsd: number | null
}

export interface CostBreakdownSummary {
  readonly totalCost: number
  readonly avgCost: number
  readonly sessionCount: number
  readonly minCostSession: SessionRef | null
  readonly maxCostSession: SessionRef | null
  readonly periods?: readonly CostPeriod[] | undefined
}

export interface CostPeriod {
  readonly period: string
  readonly totalCost: number
  readonly avgCost: number
  readonly sessionCount: number
}

export interface CostBreakdownFull {
  readonly sessions: readonly CostSessionDetail[]
}

export interface CostSessionDetail {
  readonly id: string
  readonly topic: string | null
  readonly startedAt: string | null
  readonly costUsd: number | null
  readonly totalTokens: number
  readonly cacheTokens: { readonly creation: number; readonly read: number }
}

export interface CacheAnalysisSummary {
  readonly overallHitRatio: number
  readonly avgHitRatio: number
  readonly totalCacheCreation: number
  readonly totalCacheRead: number
  readonly sessionCount: number
  readonly periods?: readonly { readonly period: string; readonly overallHitRatio: number; readonly avgHitRatio: number; readonly totalCacheCreation: number; readonly totalCacheRead: number }[] | undefined
}

export interface CacheAnalysisFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly cacheHitRatio: number
    readonly cacheCreationTokens: number
    readonly cacheReadTokens: number
    readonly totalTokens: number
  }[]
}

export interface CollapseAnalysisSummary {
  readonly totalCollapses: number
  readonly avgCollapsesPerSession: number
  readonly sessionsWithCollapses: { readonly count: number; readonly percentage: number }
  readonly maxCollapseSession: SessionRef & { readonly collapseCount: number } | null
  readonly periods?: readonly { readonly period: string; readonly totalCollapses: number; readonly sessionCount: number; readonly avgPerSession: number }[] | undefined
}

export interface CollapseAnalysisFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly totalTokens: number
    readonly collapses: readonly { readonly collapseId: string; readonly summary: string | null }[]
  }[]
}

export type ContextAuditResult =
  | CostBreakdownSummary | CostBreakdownFull
  | CacheAnalysisSummary | CacheAnalysisFull
  | CollapseAnalysisSummary | CollapseAnalysisFull
