import 'reflect-metadata'
import { Container } from 'inversify'
import { TOKENS } from './tokens'
import { DatabaseConnection } from '../infrastructure/database'
import { ClaudeCodeAdapter } from '../adapters/claude-code'
import { PiCodeAdapter } from '../adapters/pi-code'
import { CodexAdapter } from '../adapters/codex'
import { OpencodeAdapter, defaultOpencodeDbPath } from '../adapters/opencode'
import { AdapterRegistry } from '../services/adapter-registry'
import { IndexManager } from '../services/index-manager'
import { SearchIndex } from '../services/search-index'
import { FreshnessGuard } from '../services/freshness-guard'
import { TokenBudgetManager } from '../services/token-budget-manager'
import { PaginationManager } from '../services/pagination-manager'

import { LocalLlmClient } from '../services/local-llm-client'
import { createLlmClient, OpenAiLlmClient } from '../services/llm-client'
import { ProjectResolver } from '../services/project-resolver'
import { Analyzer } from '../services/analyzer'
import { ResponseFormatter } from '../services/response-formatter'
import { TurnIndexer } from '../services/turn-indexer'
import { PhaseClusterer } from '../services/phase-clusterer'
import { ContextAuditor } from '../services/context-auditor'
import { EmbeddingIndexer } from '../services/embedding-indexer'
import { ToolInvocationLogger } from '../services/invocation-logger'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Local LLM URL — override with LOCAL_LLM_URL. The model name is discovered
// at runtime from `/v1/models` (the OpenAI request body requires the field
// but local single-model servers ignore the value), so there is no
// LOCAL_LLM_MODEL constant; LOCAL_LLM_MODEL env is honored as a fallback
// label only if discovery fails.
const DEFAULT_LOCAL_LLM_URL = 'http://localhost:30000/v1'

/**
 * Shared singleton DI container. Module-level so tools and CLIs can import and
 * `container.get(TOKENS.X)` without threading the container through every call site.
 */
export const container = new Container()

let registered = false

export function registerInfrastructure(): void {
  if (registered) return
  registered = true

  const claudeDir = join(homedir(), '.claude')
  const localLlmUrl = process.env['LOCAL_LLM_URL'] ?? DEFAULT_LOCAL_LLM_URL
  const localLlmModelFallback = process.env['LOCAL_LLM_MODEL']

  container.bind<string>(TOKENS.ClaudeDataDir).toConstantValue(claudeDir)
  container.bind<string>(TOKENS.LocalLlmUrl).toConstantValue(localLlmUrl)

  // Database
  const dbConn = new DatabaseConnection(claudeDir)
  container.bind<DatabaseConnection>(TOKENS.Database).toConstantValue(dbConn)

  // Adapters & Registry. Every adapter degrades to "no sessions" when its
  // store is absent, so registering all four is safe on a machine that only
  // runs one agent. Each store location is overridable for testing and for
  // non-default installs.
  const piDir = process.env['PI_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
  const codexDir = process.env['CODEX_DIR'] ?? join(homedir(), '.codex')
  const opencodeDb = process.env['OPENCODE_DB'] ?? defaultOpencodeDbPath()

  const registry = new AdapterRegistry()
  registry.registerAdapter(new ClaudeCodeAdapter(claudeDir))
  registry.registerAdapter(new PiCodeAdapter(piDir))
  registry.registerAdapter(new CodexAdapter(codexDir))
  registry.registerAdapter(new OpencodeAdapter(opencodeDb))
  container.bind<AdapterRegistry>(TOKENS.AdapterRegistry).toConstantValue(registry)

  // Index & Search — ensure schema/migrations run before services that depend on it.
  const db = dbConn.get()
  const indexManager = new IndexManager(db)
  // Ensure schema/migrations run before any service that depends on
  // post-v0 columns: ContextAuditor.ensureIndexes references cost_usd
  // (v3), and ToolInvocationLogger writes to tool_invocations (v5).
  indexManager.ensureSchema()
  container.bind<IndexManager>(TOKENS.IndexManager).toConstantValue(indexManager)

  const searchIndex = new SearchIndex(db)
  container.bind<SearchIndex>(TOKENS.SearchIndex).toConstantValue(searchIndex)

  const turnIndexer = new TurnIndexer(db)
  container.bind<TurnIndexer>(TOKENS.TurnIndexer).toConstantValue(turnIndexer)

  // LLM clients — local only. LocalLlmClient is the legacy summarization
  // helper used by FreshnessGuard; OpenAiLlmClient is the general-purpose
  // backend bound under TOKENS.LlmClient.
  const llmClient = new LocalLlmClient(localLlmUrl, localLlmModelFallback)
  container.bind<LocalLlmClient>(TOKENS.LocalLlmClient).toConstantValue(llmClient)
  const openAiLlmClient = createLlmClient(localLlmUrl, localLlmModelFallback)
  container.bind<OpenAiLlmClient>(TOKENS.LlmClient).toConstantValue(openAiLlmClient)

  // Services
  const tokenBudget = new TokenBudgetManager()
  container.bind<TokenBudgetManager>(TOKENS.TokenBudgetManager).toConstantValue(tokenBudget)

  const pagination = new PaginationManager()
  container.bind<PaginationManager>(TOKENS.PaginationManager).toConstantValue(pagination)

  const projectResolver = new ProjectResolver(registry)
  container.bind<ProjectResolver>(TOKENS.ProjectResolver).toConstantValue(projectResolver)

  const analyzer = new Analyzer(db)
  container.bind<Analyzer>(TOKENS.Analyzer).toConstantValue(analyzer)

  const responseFormatter = new ResponseFormatter()
  container.bind<ResponseFormatter>(TOKENS.ResponseFormatter).toConstantValue(responseFormatter)

  const phaseClusterer = new PhaseClusterer()
  container.bind<PhaseClusterer>(TOKENS.PhaseClusterer).toConstantValue(phaseClusterer)

  const contextAuditor = new ContextAuditor(db)
  contextAuditor.ensureIndexes()
  container.bind<ContextAuditor>(TOKENS.ContextAuditor).toConstantValue(contextAuditor)

  // Embedding indexer — opt-in via EMBEDDING_MODEL env var. When unset, we
  // simply don't bind the token; semantic_search uses container.isBound() to
  // surface a clean "feature disabled" error. Inversify's toConstantValue(null)
  // is legal but downstream consumers shouldn't have to null-check; checking
  // isBound is cleaner.
  const embeddingModel = process.env['EMBEDDING_MODEL']
  let embeddingIndexer: EmbeddingIndexer | null = null
  if (embeddingModel) {
    const embeddingDim = Number(process.env['EMBEDDING_DIM'] ?? '1024')
    const embeddingBaseUrl = process.env['EMBEDDING_URL'] ?? localLlmUrl
    const embeddingClient = new OpenAiLlmClient(localLlmUrl, localLlmModelFallback, {
      embeddingModel,
      embeddingDim,
      embeddingBaseUrl,
    })
    embeddingIndexer = new EmbeddingIndexer(db, embeddingClient, embeddingDim)
    container.bind<EmbeddingIndexer>(TOKENS.EmbeddingIndexer).toConstantValue(embeddingIndexer)
  }

  // FreshnessGuard built last so it can capture the (maybe-null) embedding indexer.
  const freshnessGuard = new FreshnessGuard(
    registry,
    indexManager,
    claudeDir,
    db,
    llmClient,
    turnIndexer,
    embeddingIndexer,
  )
  container.bind<FreshnessGuard>(TOKENS.FreshnessGuard).toConstantValue(freshnessGuard)

  // Tool-invocation log (V5) — schema is created via IndexManager migrations.
  const invocationLogger = new ToolInvocationLogger(db)
  container.bind<ToolInvocationLogger>(TOKENS.ToolInvocationLogger).toConstantValue(invocationLogger)
}

export function registerAll(): void {
  registerInfrastructure()
}
