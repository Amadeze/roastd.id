"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, MapPin, Truck, Clock, AlertCircle, Loader2 } from "lucide-react";

// =============================================================================
// COURIER SHIPPING SEARCH
// =============================================================================
// Handles destination search + shipping quote selection for COURIER orders.
// Uses existing Batch 3 API contracts. No new persistence.

type DestinationResult = {
  providerId: string;
  label: string;
  province?: string;
  city?: string;
  district?: string;
  subdistrict?: string;
  postalCode?: string;
  token: string;
};

type ShippingRate = {
  courierCode: string;
  courierName: string;
  serviceCode: string;
  serviceName: string;
  cost: number;
  etd: string | null;
  token: string;
};

export type CourierShippingState = {
  destinationToken: string | null;
  shippingQuoteToken: string | null;
  selectedRate: ShippingRate | null;
  shippingCost: number;
};

interface CourierShippingSearchProps {
  subdomain: string;
  b2bAccessToken?: string;
  cartItems: Array<{
    productId?: string | null;
    offeringId?: string | null;
    variantId?: string | null;
    quantity: number;
  }>;
  onShippingChange: (state: CourierShippingState) => void;
  rateChangedError: string | null;
  onClearRateChanged: () => void;
}

export function CourierShippingSearch({
  subdomain,
  b2bAccessToken,
  cartItems,
  onShippingChange,
  rateChangedError,
  onClearRateChanged,
}: CourierShippingSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DestinationResult[]>([]);
  const [selectedDestination, setSelectedDestination] = useState<DestinationResult | null>(null);
  const [rates, setRates] = useState<ShippingRate[]>([]);
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isFetchingRates, setIsFetchingRates] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced destination search
  const searchDestinations = useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setIsSearching(true);
    setSearchError(null);

    try {
      const res = await fetch(`/api/tenant/${subdomain}/shipping/destinations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
        signal: abortRef.current.signal,
      });
      const data = await res.json();

      if (!res.ok) {
        setSearchError(data.error || "Gagal mencari tujuan.");
        setResults([]);
        return;
      }

      if (data.integrationDisabled) {
        setSearchError(data.error || "Integrasi pengiriman belum aktif.");
        setResults([]);
        return;
      }

      setResults(data.results || []);
      if ((data.results || []).length === 0) {
        setSearchError("Tujuan tidak ditemukan. Coba kata kunci lain.");
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setSearchError("Gagal mencari tujuan.");
        setResults([]);
      }
    } finally {
      setIsSearching(false);
    }
  }, [subdomain]);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchDestinations(query), 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, searchDestinations]);

  // Fetch rates when destination is selected
  const fetchRates = useCallback(async (destination: DestinationResult) => {
    setIsFetchingRates(true);
    setRateError(null);
    setSelectedRate(null);

    try {
      const items = cartItems.map((item) => ({
        productId: item.productId || null,
        offeringId: item.offeringId || null,
        variantId: item.variantId || null,
        quantity: item.quantity,
      }));

      const res = await fetch(`/api/tenant/${subdomain}/shipping/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationToken: destination.token,
          items,
          ...(b2bAccessToken ? { b2bAccessToken } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRateError(data.error || "Gagal mengambil tarif pengiriman.");
        setRates([]);
        return;
      }

      setRates(data.options || []);
      if ((data.options || []).length === 0) {
        setRateError("Tidak ada tarif tersedia untuk tujuan ini.");
      }
    } catch {
      setRateError("Gagal mengambil tarif pengiriman.");
      setRates([]);
    } finally {
      setIsFetchingRates(false);
    }
  }, [subdomain, cartItems, b2bAccessToken]);

  // Fetch rates when destination changes
  useEffect(() => {
    if (selectedDestination) {
      fetchRates(selectedDestination);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDestination?.token]);

  // Clear rates when cart changes (stale quote)
  useEffect(() => {
    if (selectedDestination && selectedRate) {
      setSelectedRate(null);
      setRates([]);
      onShippingChange({
        destinationToken: selectedDestination.token,
        shippingQuoteToken: null,
        selectedRate: null,
        shippingCost: 0,
      });
      fetchRates(selectedDestination);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b2bAccessToken, JSON.stringify(cartItems)]);

  const selectDestination = (dest: DestinationResult) => {
    setSelectedDestination(dest);
    setQuery(dest.label);
    setResults([]);
    setSearchError(null);
    onClearRateChanged();
  };

  const selectRate = (rate: ShippingRate) => {
    setSelectedRate(rate);
    onShippingChange({
      destinationToken: selectedDestination?.token ?? null,
      shippingQuoteToken: rate.token,
      selectedRate: rate,
      shippingCost: rate.cost,
    });
  };

  const clearDestination = () => {
    setSelectedDestination(null);
    setSelectedRate(null);
    setRates([]);
    setQuery("");
    onShippingChange({
      destinationToken: null,
      shippingQuoteToken: null,
      selectedRate: null,
      shippingCost: 0,
    });
    onClearRateChanged();
  };

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      <label htmlFor="storefront-destination-search" className="block text-xs font-semibold text-[var(--t-text-muted)] uppercase tracking-wide">
        Tujuan Pengiriman
      </label>

      {/* Destination search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--t-text-muted)]" />
        <input
          id="storefront-destination-search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={results.length > 0 && !selectedDestination}
          aria-controls="storefront-destination-results"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedDestination(null);
            setSelectedRate(null);
            setRates([]);
          }}
          placeholder="Cari kota atau kecamatan..."
          className="w-full bg-[var(--t-bg)] text-[var(--t-text)] border border-[var(--t-border)] rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:border-[var(--t-primary)] focus:ring-1 focus:ring-[var(--t-primary)] transition-colors"
        />
        {isSearching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-[var(--t-text-muted)]" />
        )}
      </div>

      {/* Search error */}
      {searchError && (
        <div role="alert" className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{searchError}</span>
        </div>
      )}

      {/* Search results */}
      {results.length > 0 && !selectedDestination && (
        <div id="storefront-destination-results" role="listbox" aria-label="Hasil tujuan pengiriman" className="max-h-48 overflow-y-auto rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] divide-y divide-[var(--t-border)]">
          {results.map((dest) => (
            <button
              key={dest.providerId}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => selectDestination(dest)}
              className="w-full text-left px-3 py-2.5 hover:bg-[var(--t-bg)] transition-colors flex items-start gap-2"
            >
              <MapPin className="h-3.5 w-3.5 mt-0.5 text-[var(--t-primary)] flex-shrink-0" />
              <span className="text-sm text-[var(--t-text)]">{dest.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Selected destination */}
      {selectedDestination && (
        <div className="flex items-center justify-between rounded-xl border border-[var(--t-primary)]/30 bg-[var(--t-primary)]/5 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <MapPin className="h-3.5 w-3.5 text-[var(--t-primary)] flex-shrink-0" />
            <span className="text-sm font-medium text-[var(--t-text)] truncate">
              {selectedDestination.label}
            </span>
          </div>
          <button
            type="button"
            onClick={clearDestination}
            className="text-xs font-semibold text-[var(--t-text-muted)] hover:text-red-500 ml-2"
          >
            Ganti
          </button>
        </div>
      )}

      {/* Rate fetch error */}
      {rateError && selectedDestination && (
        <div role="alert" className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{rateError}</span>
        </div>
      )}

      {/* Loading rates */}
      {isFetchingRates && (
        <div className="flex items-center justify-center py-4 text-sm text-[var(--t-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Memuat tarif pengiriman...
        </div>
      )}

      {/* Shipping rates */}
      {rates.length > 0 && !isFetchingRates && (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-[var(--t-text-muted)] uppercase tracking-wide">
            Pilih Layanan
          </label>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {rates.map((rate) => (
              <button
                key={`${rate.courierCode}-${rate.serviceCode}`}
                type="button"
                aria-pressed={selectedRate?.token === rate.token}
                onClick={() => selectRate(rate)}
                className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
                  selectedRate?.token === rate.token
                    ? "border-[var(--t-primary)] bg-[var(--t-primary)]/5 ring-1 ring-[var(--t-primary)]"
                    : "border-[var(--t-border)] hover:border-[var(--t-primary)]/50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Truck className="h-3.5 w-3.5 text-[var(--t-text-muted)]" />
                    <span className="text-sm font-semibold text-[var(--t-text)]">
                      {rate.courierName}
                    </span>
                    <span className="text-xs text-[var(--t-text-muted)]">
                      {rate.serviceName}
                    </span>
                  </div>
                  <span className="text-sm font-bold text-[var(--t-text)]">
                    Rp {rate.cost.toLocaleString("id-ID")}
                  </span>
                </div>
                {rate.etd && (
                  <div className="flex items-center gap-1 mt-1">
                    <Clock className="h-3 w-3 text-[var(--t-text-muted)]" />
                    <span className="text-[11px] text-[var(--t-text-muted)]">
                      Estimasi: {rate.etd}
                    </span>
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* SHIPPING_RATE_CHANGED warning */}
      {rateChangedError && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-bold mb-1">Harga ongkir berubah</p>
          <p className="text-xs mb-2">{rateChangedError}</p>
          <p className="text-xs">Silakan pilih ulang tujuan dan layanan pengiriman.</p>
        </div>
      )}
    </div>
  );
}
