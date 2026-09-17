import { expect, test } from "@playwright/test";

test("dual-market runtime and persisted universe history remain market scoped", async ({
  request,
}) => {
  const all = await request.get("/api/market/status?marketId=ALL");
  expect(all.status()).toBe(200);
  const { markets } = await all.json();
  expect(
    markets.map((market: { marketId: string }) => market.marketId).sort(),
  ).toEqual(["CA_TSX", "US_EQUITIES"]);
  for (const [marketId, currency] of [
    ["CA_TSX", "CAD"],
    ["US_EQUITIES", "USD"],
  ]) {
    const universe = await request.get(`/api/universe?marketId=${marketId}`);
    expect(universe.status()).toBe(200);
    const body = await universe.json();
    expect(body.instruments.length).toBeGreaterThan(0);
    for (const instrument of body.instruments)
      expect(instrument).toMatchObject({ marketId, currency });
    const history = await request.get(
      `/api/universe/runs?marketId=${marketId}&limit=3`,
    );
    expect(history.status()).toBe(200);
    const { runs } = await history.json();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.marketId).toBe(marketId);
  }
  const mixedHistory = await request.get(
    "/api/universe/runs?marketId=ALL&limit=100",
  );
  const { runs } = await mixedHistory.json();
  expect(
    new Set(runs.map((run: { marketId: string }) => run.marketId)),
  ).toEqual(new Set(["CA_TSX", "US_EQUITIES"]));
  expect(new Set(runs.map((run: { id: string }) => run.id)).size).toBe(
    runs.length,
  );
  const mutation = await request.post("/api/universe/refresh?marketId=ALL");
  expect(mutation.status()).toBe(400);
  const invalid = await request.get("/api/market/status?marketId=INVALID");
  expect(invalid.status()).toBe(400);
});
