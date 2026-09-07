import { weightedAverageCost } from "./financial-reporting";

 
type DecimalLike = any;
type RoastingBatchInput = {
  inputProductId: string;
  targetWeightKg: DecimalLike;
  actualOutputKg: DecimalLike | null;
};

/**
 * Hitung cost per kg roasted bean dari roasting batches (simple aggregate).
 * Sama seperti logic lama di getCoffeeFlowReport.
 */
export function roastedBeanCostFromBatches(
  batches: RoastingBatchInput[],
  gbPriceMap: Map<string, number>,
): number {
  let totalInputCost = 0;
  let totalOutputKg = 0;
  for (const b of batches) {
    const inW = Number(b.targetWeightKg);
    const outW = Number(b.actualOutputKg ?? 0);
    const gbPrice = gbPriceMap.get(b.inputProductId) ?? 0;
    totalInputCost += inW * gbPrice;
    totalOutputKg += outW;
  }
  return totalOutputKg > 0 ? totalInputCost / totalOutputKg : 0;
}

/**
 * Hitung cost per kg roasted bean dari roasting batches (layer-based WAC).
 * Sama seperti logic lama di getInventoryValuationReport.
 */
export function roastedBeanCostWAC(
  batches: RoastingBatchInput[],
  gbPriceMap: Map<string, number>,
): number {
  const layers = batches.map((b) => ({
    quantity: Number(b.actualOutputKg ?? 0),
    totalCost: Number(b.targetWeightKg) * (gbPriceMap.get(b.inputProductId) ?? 0),
  }));
  return weightedAverageCost(layers);
}

/**
 * Hitung RB cost dengan memprioritaskan cache avgCostPerKg dari database.
 * 1. Gunakan avgCostPerKgFallback jika valid (> 0)
 * 2. Kalau 0 atau tidak ada, fallback ke kalkulasi roasting batch (WAC)
 */
export function getRbCostPrioritizingCache(
  avgCostPerKg: number,
  batches: RoastingBatchInput[],
  gbPriceMap: Map<string, number>,
): number {
  if (avgCostPerKg > 0) return avgCostPerKg;
  return roastedBeanCostWAC(batches, gbPriceMap);
}

/**
 * Hitung HPP per unit Finished Goods dengan memprioritaskan snapshot HPP (lastHpp atau production batch)
 * 1. Gunakan lastHpp jika valid (> 0)
 * 2. Kalau tidak ada, fallback ke HPP produksi terakhir (productionBatchHpp)
 * 3. Kalau masih tidak ada, rekonstruksi dari Recipe.
 */
export function getFgHppPrioritizingCache(
  lastHpp: number | null | undefined,
  productionBatchHpp: number | null | undefined,
  recipeItems: RecipeItem[],
  recipePackagingId: string | null | undefined,
  rbCostMap: Map<string, number>,
  packagingCostMap: Map<string, number>,
  packagingMasterCost: number,
  laborOverheadPerUnit?: number,
  recipeSupplyItems?: RecipeSupplyItem[],
  supplyCostMap?: Map<string, number>,
  packagingSupplyItemId?: string | null,
): number {
  if (lastHpp && lastHpp > 0) return Number(lastHpp);
  if (productionBatchHpp && productionBatchHpp > 0) return Number(productionBatchHpp);
  return fgHppFromRecipe(
    recipeItems,
    recipePackagingId,
    rbCostMap,
    packagingCostMap,
    packagingMasterCost,
    laborOverheadPerUnit,
    recipeSupplyItems,
    supplyCostMap,
    packagingSupplyItemId,
  );
}

type RecipeItem = { productId: string; gramsPerUnit: DecimalLike };

type RecipeSupplyItem = { supplyItemId: string; quantityPerUnit: DecimalLike };

/**
 * Hitung HPP per unit finished goods dari recipe + RB cost + packaging cost.
 * Dipakai bersama oleh Valuasi Aset dan Coffee Flow.
 *
 * Komponen non-kopi (RecipeSupplyItem) dihitung dari supplyCostMap.
 * packagingSupplyItemId: canonical supply item dari packaging legacy recipe —
 * bila ia juga muncul di recipeSupplyItems, jangan dihitung dua kali.
 */
export function fgHppFromRecipe(
  items: RecipeItem[],
  packagingId: string | null | undefined,
  rbCostMap: Map<string, number>,
  packagingCostMap: Map<string, number>,
  packagingMasterCost: number,
  laborOverheadPerUnit?: number,
  recipeSupplyItems: RecipeSupplyItem[] = [],
  supplyCostMap: Map<string, number> = new Map(),
  packagingSupplyItemId?: string | null,
): number {
  let cost = 0;
  for (const item of items) {
    const rbCost = rbCostMap.get(item.productId) ?? 0;
    cost += rbCost * (Number(item.gramsPerUnit) / 1000);
  }
  if (packagingId) {
    cost += packagingCostMap.get(packagingId) ?? packagingMasterCost;
  }
  for (const supplyItem of recipeSupplyItems) {
    if (supplyItem.supplyItemId === packagingSupplyItemId) continue;
    cost += (supplyCostMap.get(supplyItem.supplyItemId) ?? 0) * Number(supplyItem.quantityPerUnit);
  }
  if (laborOverheadPerUnit && laborOverheadPerUnit > 0) {
    cost += laborOverheadPerUnit;
  }
  return cost;
}
