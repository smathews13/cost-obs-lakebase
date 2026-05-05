/**
 * PricingContext — provides the active pricing multiplier to all components.
 *
 * When `use_account_prices` is enabled in Settings, the backend computes a
 * usage-weighted blended multiplier (account_price / list_price) from
 * system.billing.account_prices. All spend values in the UI are scaled by
 * this multiplier, reflecting the customer's negotiated rates.
 */
import React, { createContext, useContext, useEffect, useState } from "react";

interface PricingState {
  useAccountPrices: boolean;
  multiplier: number;
  discountPercent: number;
  skuCount: number;
  available: boolean;
  loading: boolean;
  /** Scale a spend amount by the active pricing multiplier */
  applyPricing: (amount: number) => number;
  /** Toggle the setting and reload multiplier */
  setUseAccountPrices: (enabled: boolean) => Promise<void>;
}

const PricingContext = createContext<PricingState>({
  useAccountPrices: false,
  multiplier: 1.0,
  discountPercent: 0,
  skuCount: 0,
  available: false,
  loading: true,
  applyPricing: (x) => x,
  setUseAccountPrices: async () => {},
});

export function PricingProvider({ children }: { children: React.ReactNode }) {
  const [useAccountPrices, setUseAccountPricesState] = useState(false);
  const [multiplier, setMultiplier] = useState(1.0);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [skuCount, setSkuCount] = useState(0);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadMultiplier = async () => {
    try {
      const res = await fetch("/api/settings/account-price-multiplier");
      if (!res.ok) return;
      const data = await res.json();
      setMultiplier(data.multiplier ?? 1.0);
      setDiscountPercent(data.discount_percent ?? 0);
      setSkuCount(data.sku_count ?? 0);
      setAvailable(data.available ?? false);
    } catch {
      setMultiplier(1.0);
      setAvailable(false);
    }
  };

  useEffect(() => {
    // Load pricing mode preference from server
    fetch("/api/settings/pricing-mode")
      .then((r) => r.json())
      .then((d) => {
        setUseAccountPricesState(d.use_account_prices ?? false);
        if (d.use_account_prices) {
          return loadMultiplier();
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const setUseAccountPrices = async (enabled: boolean) => {
    await fetch("/api/settings/pricing-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ use_account_prices: enabled }),
    });
    setUseAccountPricesState(enabled);
    if (enabled) {
      setLoading(true);
      await loadMultiplier();
      setLoading(false);
    } else {
      setMultiplier(1.0);
      setDiscountPercent(0);
      setAvailable(false);
    }
  };

  return (
    <PricingContext.Provider
      value={{
        useAccountPrices,
        multiplier,
        discountPercent,
        skuCount,
        available,
        loading,
        applyPricing: (amount: number) => amount * multiplier,
        setUseAccountPrices,
      }}
    >
      {children}
    </PricingContext.Provider>
  );
}

export function usePricing() {
  return useContext(PricingContext);
}
