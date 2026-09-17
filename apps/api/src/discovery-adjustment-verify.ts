import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { marketIdSchema, type MarketId } from "@tsx-scanner/contracts";
import { loadConfig } from "./config.js";
import { EncryptedPostgresRefreshTokenStore } from "./market-data/postgres-token-store.js";
import { QuestradeRateLimiter } from "./questrade/rate-limiter.js";
import { PostgresRequestBudget } from "./questrade/postgres-request-budget.js";
import {
  mockDevelopmentKey,
  parseMasterKey,
} from "./questrade/token-crypto.js";
import { QuestradeTokenManager } from "./questrade/token-manager.js";
import { LiveQuestradeTransport } from "./questrade/live-transport.js";
import { MockQuestradeTransport } from "./questrade/mock-transport.js";
import { QuestradeAdapter } from "./questrade/adapter.js";
import { DiscoverySymbolMapper } from "./universe/discovery-mapping.js";
import { EodhdCorporateActionClient } from "./universe/eodhd-corporate-actions.js";
import { MassiveCorporateActionClient } from "./universe/massive-corporate-actions.js";
import {
  PostgresCatalogSnapshotStore,
  PostgresDiscoveryMappingStore,
} from "./universe/postgres-discovery-provider-store.js";
import {
  VERIFICATION_ROUNDS,
  buildFrozenSampleSet,
  buildMassiveUsSampleSet,
  collectVerificationRound,
  parseVerificationEvidence,
  revisionComparisons,
  roundStatus,
  runWithRetainedEvidencePreflight,
  type StoredVerificationEvidence,
} from "./universe/discovery-adjustment-verification-runner.js";
import { DEFAULT_ADJUSTMENT_CRITERIA } from "./universe/discovery-adjustment-verification.js";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("--")) ?? "run";
if (command !== "run" && command !== "status")
  throw new Error(
    "Usage: discovery-adjustment-verify [run|status] [--market=CA_TSX] [--evidence-dir=/evidence]",
  );
const marketFlag = args.find((arg) => arg.startsWith("--market="));
const marketId: MarketId = marketFlag
  ? marketIdSchema.parse(marketFlag.slice("--market=".length))
  : "CA_TSX";
const timezone = marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
const dirFlag = args.find((arg) => arg.startsWith("--evidence-dir="));
const evidenceDir =
  dirFlag?.slice("--evidence-dir=".length) ??
  process.env.DISCOVERY_VERIFICATION_DIR ??
  "/evidence";
const marketDir = join(evidenceDir, marketId);
const evidencePath = join(marketDir, "evidence.json");
const logPath = join(marketDir, "run.log");

const clock = () => new Date();
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock());

async function loadEvidence(): Promise<StoredVerificationEvidence> {
  let raw: string;
  try {
    raw = await readFile(evidencePath, "utf8");
  } catch {
    return {
      protocolRevision: DEFAULT_ADJUSTMENT_CRITERIA.revision,
      sampleSet: null,
      rounds: [],
      report: null,
    };
  }
  // A present but structurally invalid evidence file must fail visibly rather
  // than silently starting a fresh protocol clock over retained history.
  return parseVerificationEvidence(JSON.parse(raw));
}

async function saveEvidence(
  evidence: StoredVerificationEvidence,
): Promise<void> {
  await mkdir(marketDir, { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  const last = evidence.rounds.at(-1);
  await appendFile(
    logPath,
    `${new Date().toISOString()} status=${evidence.report?.status ?? "PENDING"} rounds=${evidence.rounds.length} lastRound=${last?.collectedAt ?? "none"} missing=${last?.missing.length ?? 0}\n`,
  );
}

async function main(): Promise<void> {
  const evidence = await loadEvidence();
  if (command === "status") {
    const comparisons = revisionComparisons(
      evidence.sampleSet ?? undefined,
      evidence.rounds,
    );
    console.log(
      JSON.stringify(
        {
          marketId,
          protocolRevision: evidence.protocolRevision,
          frozenAt: evidence.sampleSet?.frozenAt ?? null,
          sampleCount: evidence.sampleSet?.samples.length ?? 0,
          limitations: evidence.sampleSet?.limitations ?? [],
          rounds: evidence.rounds.length,
          requiredRounds: VERIFICATION_ROUNDS,
          revisionComparisons: comparisons,
          comparable:
            comparisons.length > 0 &&
            comparisons.every((value) => value.status === "COMPARED"),
          lastRound: evidence.rounds.at(-1) ?? null,
          report: evidence.report,
        },
        null,
        2,
      ),
    );
    return;
  }

  await runWithRetainedEvidencePreflight(
    evidence,
    async () => {
      const config = loadConfig();
      if (!config.DATABASE_URL)
        throw new Error(
          "DATABASE_URL is required; this command never migrates",
        );
      if (marketId === "CA_TSX" && !config.EODHD_API_TOKEN)
        throw new Error(
          "EODHD_API_TOKEN is required for CA corporate action evidence",
        );
      if (marketId === "US_EQUITIES" && !config.MASSIVE_API_KEY)
        throw new Error(
          "MASSIVE_API_KEY is required for US corporate action evidence",
        );

      const isLive = config.MARKET_DATA_MODE === "live";
      const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
      try {
        const masterKey = isLive
          ? parseMasterKey(config.APP_MASTER_KEY!)
          : mockDevelopmentKey();
        const tokenStore = new EncryptedPostgresRefreshTokenStore(
          pool,
          masterKey,
          isLive ? "questrade_live" : "questrade_mock",
        );
        await tokenStore.initialize(
          isLive ? config.QUESTRADE_REFRESH_TOKEN! : "mock-refresh-token-0",
        );
        const rateLimiter = new QuestradeRateLimiter(
          2,
          2,
          clock,
          isLive
            ? new PostgresRequestBudget(pool, "questrade_live")
            : undefined,
        );
        const transport = isLive
          ? new LiveQuestradeTransport(fetch, (headers, status) =>
              rateLimiter.observeHeaders(headers, status),
            )
          : new MockQuestradeTransport();
        const tokenManager = new QuestradeTokenManager(
          transport,
          tokenStore,
          clock,
          30_000,
          rateLimiter,
        );
        const adapter = new QuestradeAdapter(
          tokenManager,
          transport,
          clock,
          isLive ? "QUESTRADE" : "QUESTRADE_MOCK",
          rateLimiter,
        );
        const discoveryAdapter = adapter.forDiscovery();
        return {
          pool,
          catalogStore: new PostgresCatalogSnapshotStore(pool),
          mapper: new DiscoverySymbolMapper(
            discoveryAdapter,
            new PostgresDiscoveryMappingStore(pool),
            clock,
          ),
          discoveryAdapter,
          eodhd: config.EODHD_API_TOKEN
            ? new EodhdCorporateActionClient(config.EODHD_API_TOKEN)
            : null,
          massive: config.MASSIVE_API_KEY
            ? new MassiveCorporateActionClient(config.MASSIVE_API_KEY)
            : null,
        };
      } catch (error) {
        await pool.end();
        throw error;
      }
    },
    async ({
      pool,
      catalogStore,
      mapper,
      discoveryAdapter,
      eodhd,
      massive,
    }) => {
      try {
        const snapshot = await catalogStore.loadLatest(marketId);
        if (!evidence.sampleSet) {
          if (!snapshot)
            throw new Error("No catalog snapshot; refresh discovery first");
          evidence.sampleSet =
            marketId === "CA_TSX"
              ? await buildFrozenSampleSet({
                  marketId,
                  members: snapshot.members,
                  eodhd: eodhd!,
                  now: clock(),
                  logger: (fields) => console.log(JSON.stringify(fields)),
                })
              : await buildMassiveUsSampleSet({
                  members: snapshot.members,
                  client: massive!,
                  now: clock(),
                  logger: (fields) => console.log(JSON.stringify(fields)),
                });
          await saveEvidence(evidence);
        }
        const lastRoundDate = evidence.rounds.at(-1)?.collectedAt;
        const alreadyCollectedToday =
          lastRoundDate !== undefined &&
          new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(lastRoundDate)) === today();
        if (evidence.rounds.length >= VERIFICATION_ROUNDS) {
          const outcome = roundStatus(evidence.sampleSet, evidence.rounds);
          if (outcome.status !== "PENDING")
            evidence.report = {
              status: outcome.status,
              report: outcome.report,
              revisionFindings: outcome.revisionFindings,
              comparisons: outcome.revisionComparisons,
              blockers: outcome.blockers,
            };
          await saveEvidence(evidence);
          console.log(JSON.stringify({ marketId, ...outcome }, null, 2));
        } else if (alreadyCollectedToday) {
          console.log(
            JSON.stringify({
              marketId,
              status: "SKIPPED_ALREADY_COLLECTED_TODAY",
              rounds: evidence.rounds.length,
            }),
          );
        } else {
          const needed = new Set(
            evidence.sampleSet.samples.map((record) => record.sample.symbol),
          );
          const symbolIds = new Map<string, number>();
          for (const member of snapshot?.members ?? []) {
            if (!needed.has(member.providerCode) || member.reasons.length > 0)
              continue;
            try {
              const decision = await mapper.resolve(marketId, member);
              if (decision.status === "RESOLVED" && decision.instrument)
                symbolIds.set(
                  member.providerCode,
                  decision.instrument.symbolId,
                );
            } catch (error) {
              console.log(
                JSON.stringify({
                  event: "DISCOVERY_ADJUSTMENT_MAPPING_FAILED",
                  code: member.providerCode,
                  error: error instanceof Error ? error.message : "unknown",
                }),
              );
            }
          }
          const round = await collectVerificationRound({
            sampleSet: evidence.sampleSet,
            adapter: discoveryAdapter,
            symbolIds,
            previous: evidence.rounds.at(-1),
            now: clock(),
            timezone,
            logger: (fields) => console.log(JSON.stringify(fields)),
          });
          evidence.rounds.push(round);
          const outcome = roundStatus(evidence.sampleSet, evidence.rounds);
          if (outcome.status !== "PENDING")
            evidence.report = {
              status: outcome.status,
              report: outcome.report,
              revisionFindings: outcome.revisionFindings,
              comparisons: outcome.revisionComparisons,
              blockers: outcome.blockers,
            };
          await saveEvidence(evidence);
          console.log(
            JSON.stringify(
              {
                marketId,
                round: round.round,
                rounds: evidence.rounds.length,
                requiredRounds: VERIFICATION_ROUNDS,
                observations: round.observations.length,
                missing: round.missing.length,
                revisionFindings: round.revisionFindings,
                revisionComparison: round.revisionComparison ?? null,
                status: outcome.status,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        await pool.end();
      }
    },
  );
}

await main();
