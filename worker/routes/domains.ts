/**
 * Every domain gateway the Worker answers, in one table.
 *
 * Each entry pairs a route prefix with a gateway built from three pieces that
 * already exist: server/gateway.ts, the generated route table for the domain,
 * and the domain's handler. The Worker used to carry one module per domain --
 * market, maritime, supply-chain -- and adding the other 32 that way would have
 * meant 32 more copies of the same eight lines, plus 32 more branches in
 * worker/index.ts. The table replaces all of it with one branch.
 *
 * What is NOT here: /api/bootstrap, /ais/snapshot, the counter read and the
 * session endpoint. Those are not domain RPCs and keep their own modules.
 *
 * A path that matches no prefix still falls through to the UPSTREAM_API_ORIGIN
 * proxy, which is where the remaining non-domain /api/* handlers live.
 */
import { createDomainGateway, serverOptions, type GatewayCtx } from '../../server/gateway';
import { setRelayFetch } from '../../server/_shared/relay';
import type { AisRelayEnv } from './ais-snapshot';
import { relayFetchViaDurableObject } from './maritime';

import { createAviationServiceRoutes } from '../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { createBatchServiceRoutes } from '../../src/generated/server/worldmonitor/batch/v1/service_server';
import { createClimateServiceRoutes } from '../../src/generated/server/worldmonitor/climate/v1/service_server';
import { createConflictServiceRoutes } from '../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { createConsumerPricesServiceRoutes } from '../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';
import { createCyberServiceRoutes } from '../../src/generated/server/worldmonitor/cyber/v1/service_server';
import { createDisplacementServiceRoutes } from '../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { createEconomicServiceRoutes } from '../../src/generated/server/worldmonitor/economic/v1/service_server';
import { createForecastServiceRoutes } from '../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { createGivingServiceRoutes } from '../../src/generated/server/worldmonitor/giving/v1/service_server';
import { createHealthServiceRoutes } from '../../src/generated/server/worldmonitor/health/v1/service_server';
import { createImageryServiceRoutes } from '../../src/generated/server/worldmonitor/imagery/v1/service_server';
import { createInfrastructureServiceRoutes } from '../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { createIntelligenceServiceRoutes } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { createLeadsServiceRoutes } from '../../src/generated/server/worldmonitor/leads/v1/service_server';
import { createMaritimeServiceRoutes } from '../../src/generated/server/worldmonitor/maritime/v1/service_server';
import { createMarketServiceRoutes } from '../../src/generated/server/worldmonitor/market/v1/service_server';
import { createMilitaryServiceRoutes } from '../../src/generated/server/worldmonitor/military/v1/service_server';
import { createNaturalServiceRoutes } from '../../src/generated/server/worldmonitor/natural/v1/service_server';
import { createNewsServiceRoutes } from '../../src/generated/server/worldmonitor/news/v1/service_server';
import { createPositiveEventsServiceRoutes } from '../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { createPredictionServiceRoutes } from '../../src/generated/server/worldmonitor/prediction/v1/service_server';
import { createRadiationServiceRoutes } from '../../src/generated/server/worldmonitor/radiation/v1/service_server';
import { createResearchServiceRoutes } from '../../src/generated/server/worldmonitor/research/v1/service_server';
import { createResilienceServiceRoutes } from '../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { createSanctionsServiceRoutes } from '../../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { createScenarioServiceRoutes } from '../../src/generated/server/worldmonitor/scenario/v1/service_server';
import { createSeismologyServiceRoutes } from '../../src/generated/server/worldmonitor/seismology/v1/service_server';
import { createShippingV2ServiceRoutes } from '../../src/generated/server/worldmonitor/shipping/v2/service_server';
import { createSupplyChainServiceRoutes } from '../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { createThermalServiceRoutes } from '../../src/generated/server/worldmonitor/thermal/v1/service_server';
import { createTradeServiceRoutes } from '../../src/generated/server/worldmonitor/trade/v1/service_server';
import { createUnrestServiceRoutes } from '../../src/generated/server/worldmonitor/unrest/v1/service_server';
import { createWebcamServiceRoutes } from '../../src/generated/server/worldmonitor/webcam/v1/service_server';
import { createWildfireServiceRoutes } from '../../src/generated/server/worldmonitor/wildfire/v1/service_server';

import { aviationHandler } from '../../server/worldmonitor/aviation/v1/handler';
import { batchHandler } from '../../server/worldmonitor/batch/v1/handler';
import { climateHandler } from '../../server/worldmonitor/climate/v1/handler';
import { conflictHandler } from '../../server/worldmonitor/conflict/v1/handler';
import { consumerPricesHandler } from '../../server/worldmonitor/consumer-prices/v1/handler';
import { cyberHandler } from '../../server/worldmonitor/cyber/v1/handler';
import { displacementHandler } from '../../server/worldmonitor/displacement/v1/handler';
import { economicHandler } from '../../server/worldmonitor/economic/v1/handler';
import { forecastHandler } from '../../server/worldmonitor/forecast/v1/handler';
import { givingHandler } from '../../server/worldmonitor/giving/v1/handler';
import { healthHandler } from '../../server/worldmonitor/health/v1/handler';
import { imageryHandler } from '../../server/worldmonitor/imagery/v1/handler';
import { infrastructureHandler } from '../../server/worldmonitor/infrastructure/v1/handler';
import { intelligenceHandler } from '../../server/worldmonitor/intelligence/v1/handler';
import { leadsHandler } from '../../server/worldmonitor/leads/v1/handler';
import { maritimeHandler } from '../../server/worldmonitor/maritime/v1/handler';
import { marketHandler } from '../../server/worldmonitor/market/v1/handler';
import { militaryHandler } from '../../server/worldmonitor/military/v1/handler';
import { naturalHandler } from '../../server/worldmonitor/natural/v1/handler';
import { newsHandler } from '../../server/worldmonitor/news/v1/handler';
import { positiveEventsHandler } from '../../server/worldmonitor/positive-events/v1/handler';
import { predictionHandler } from '../../server/worldmonitor/prediction/v1/handler';
import { radiationHandler } from '../../server/worldmonitor/radiation/v1/handler';
import { researchHandler } from '../../server/worldmonitor/research/v1/handler';
import { resilienceHandler } from '../../server/worldmonitor/resilience/v1/handler';
import { sanctionsHandler } from '../../server/worldmonitor/sanctions/v1/handler';
import { scenarioHandler } from '../../server/worldmonitor/scenario/v1/handler';
import { seismologyHandler } from '../../server/worldmonitor/seismology/v1/handler';
import { shippingV2Handler } from '../../server/worldmonitor/shipping/v2/handler';
import { supplyChainHandler } from '../../server/worldmonitor/supply-chain/v1/handler';
import { thermalHandler } from '../../server/worldmonitor/thermal/v1/handler';
import { tradeHandler } from '../../server/worldmonitor/trade/v1/handler';
import { unrestHandler } from '../../server/worldmonitor/unrest/v1/handler';
import { webcamHandler } from '../../server/worldmonitor/webcam/v1/handler';
import { wildfireHandler } from '../../server/worldmonitor/wildfire/v1/handler';

/**
 * Market RPCs that must keep going to the upstream origin.
 *
 * Emptied 2026-08-03. A spike on a real Cloudflare edge node (PoP SJC) got 401
 * from both OpenRouter and Groq with an invalid key, not the 403 a geo-block
 * returns -- so the Vercel region pin the four LLM-touching paths carried
 * (iad1/lhr1/fra1/sfo1, incident #4944 U7) does not reproduce here. SJC matches
 * the already-allowed sfo1, so PoPs outside the four pinned regions remain
 * untested. If non-US PoPs log 403s from these providers, put the four paths
 * back in this set -- that is the whole revert.
 */
export const MARKET_PATHS_STAYING_ON_VERCEL: ReadonlySet<string> = new Set([]);

type DomainRoute = {
  readonly prefix: string;
  readonly gateway: (request: Request, ctx?: GatewayCtx) => Promise<Response>;
  /** Paths under the prefix that keep going upstream. */
  readonly excluded?: ReadonlySet<string>;
};

function gatewayFor(routes: Parameters<typeof createDomainGateway>[0]): DomainRoute['gateway'] {
  return createDomainGateway(routes);
}

const DOMAIN_ROUTES: readonly DomainRoute[] = [
  { prefix: '/api/aviation/v1/', gateway: gatewayFor(createAviationServiceRoutes(aviationHandler, serverOptions)) },
  { prefix: '/api/batch/v1/', gateway: gatewayFor(createBatchServiceRoutes(batchHandler, serverOptions)) },
  { prefix: '/api/climate/v1/', gateway: gatewayFor(createClimateServiceRoutes(climateHandler, serverOptions)) },
  { prefix: '/api/conflict/v1/', gateway: gatewayFor(createConflictServiceRoutes(conflictHandler, serverOptions)) },
  { prefix: '/api/consumer-prices/v1/', gateway: gatewayFor(createConsumerPricesServiceRoutes(consumerPricesHandler, serverOptions)) },
  { prefix: '/api/cyber/v1/', gateway: gatewayFor(createCyberServiceRoutes(cyberHandler, serverOptions)) },
  { prefix: '/api/displacement/v1/', gateway: gatewayFor(createDisplacementServiceRoutes(displacementHandler, serverOptions)) },
  { prefix: '/api/economic/v1/', gateway: gatewayFor(createEconomicServiceRoutes(economicHandler, serverOptions)) },
  { prefix: '/api/forecast/v1/', gateway: gatewayFor(createForecastServiceRoutes(forecastHandler, serverOptions)) },
  { prefix: '/api/giving/v1/', gateway: gatewayFor(createGivingServiceRoutes(givingHandler, serverOptions)) },
  { prefix: '/api/health/v1/', gateway: gatewayFor(createHealthServiceRoutes(healthHandler, serverOptions)) },
  { prefix: '/api/imagery/v1/', gateway: gatewayFor(createImageryServiceRoutes(imageryHandler, serverOptions)) },
  { prefix: '/api/infrastructure/v1/', gateway: gatewayFor(createInfrastructureServiceRoutes(infrastructureHandler, serverOptions)) },
  { prefix: '/api/intelligence/v1/', gateway: gatewayFor(createIntelligenceServiceRoutes(intelligenceHandler, serverOptions)) },
  { prefix: '/api/leads/v1/', gateway: gatewayFor(createLeadsServiceRoutes(leadsHandler, serverOptions)) },
  { prefix: '/api/maritime/v1/', gateway: gatewayFor(createMaritimeServiceRoutes(maritimeHandler, serverOptions)) },
  { prefix: '/api/market/v1/', gateway: gatewayFor(createMarketServiceRoutes(marketHandler, serverOptions)), excluded: MARKET_PATHS_STAYING_ON_VERCEL },
  { prefix: '/api/military/v1/', gateway: gatewayFor(createMilitaryServiceRoutes(militaryHandler, serverOptions)) },
  { prefix: '/api/natural/v1/', gateway: gatewayFor(createNaturalServiceRoutes(naturalHandler, serverOptions)) },
  { prefix: '/api/news/v1/', gateway: gatewayFor(createNewsServiceRoutes(newsHandler, serverOptions)) },
  { prefix: '/api/positive-events/v1/', gateway: gatewayFor(createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions)) },
  { prefix: '/api/prediction/v1/', gateway: gatewayFor(createPredictionServiceRoutes(predictionHandler, serverOptions)) },
  { prefix: '/api/radiation/v1/', gateway: gatewayFor(createRadiationServiceRoutes(radiationHandler, serverOptions)) },
  { prefix: '/api/research/v1/', gateway: gatewayFor(createResearchServiceRoutes(researchHandler, serverOptions)) },
  { prefix: '/api/resilience/v1/', gateway: gatewayFor(createResilienceServiceRoutes(resilienceHandler, serverOptions)) },
  { prefix: '/api/sanctions/v1/', gateway: gatewayFor(createSanctionsServiceRoutes(sanctionsHandler, serverOptions)) },
  { prefix: '/api/scenario/v1/', gateway: gatewayFor(createScenarioServiceRoutes(scenarioHandler, serverOptions)) },
  { prefix: '/api/seismology/v1/', gateway: gatewayFor(createSeismologyServiceRoutes(seismologyHandler, serverOptions)) },
  { prefix: '/api/v2/shipping/', gateway: gatewayFor(createShippingV2ServiceRoutes(shippingV2Handler, serverOptions)) },
  { prefix: '/api/supply-chain/v1/', gateway: gatewayFor(createSupplyChainServiceRoutes(supplyChainHandler, serverOptions)) },
  { prefix: '/api/thermal/v1/', gateway: gatewayFor(createThermalServiceRoutes(thermalHandler, serverOptions)) },
  { prefix: '/api/trade/v1/', gateway: gatewayFor(createTradeServiceRoutes(tradeHandler, serverOptions)) },
  { prefix: '/api/unrest/v1/', gateway: gatewayFor(createUnrestServiceRoutes(unrestHandler, serverOptions)) },
  { prefix: '/api/webcam/v1/', gateway: gatewayFor(createWebcamServiceRoutes(webcamHandler, serverOptions)) },
  { prefix: '/api/wildfire/v1/', gateway: gatewayFor(createWildfireServiceRoutes(wildfireHandler, serverOptions)) },
];

/** Every prefix in the table, for tests and for anything auditing coverage. */
export const DOMAIN_ROUTE_PREFIXES: readonly string[] = DOMAIN_ROUTES.map((route) => route.prefix);

function matchDomainRoute(pathname: string): DomainRoute | undefined {
  return DOMAIN_ROUTES.find(
    (route) => pathname.startsWith(route.prefix) && !route.excluded?.has(pathname),
  );
}

export function isDomainPathHandledInWorker(pathname: string): boolean {
  return matchDomainRoute(pathname) !== undefined;
}

/**
 * Answers one domain RPC in-Worker.
 *
 * The relay override goes in for every domain, not just maritime. Nine domains
 * reach the relay, and getVesselSnapshot is called from supply-chain as well as
 * from maritime itself; without the override those calls fetch this Worker's
 * own hostname and time out at HTTP 522 instead of re-entering. Setting it per
 * request is deliberate -- the binding arrives with the request.
 */
export async function handleDomainRpc(
  request: Request,
  env: AisRelayEnv,
  ctx?: GatewayCtx,
): Promise<Response> {
  const route = matchDomainRoute(new URL(request.url).pathname);
  if (!route) {
    // isDomainPathHandledInWorker gates every caller, so this is unreachable
    // unless the two fall out of step.
    return new Response('Not Found', { status: 404 });
  }
  setRelayFetch(relayFetchViaDurableObject(env, new URL(request.url).origin));
  return route.gateway(request, ctx);
}
