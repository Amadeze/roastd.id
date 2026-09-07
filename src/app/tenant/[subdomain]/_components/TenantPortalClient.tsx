"use client";

import { Tenant, Product } from "@prisma/client";
import { useCartStore } from "../_store/cartStore";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { UniversalTheme } from "./themes/UniversalTheme";
import {
  offeringLineId,
  storefrontLineId,
  type StorefrontGrindSize,
  type StorefrontOffering,
} from "@/lib/storefront-grind";
import type { CourierShippingState } from "./CourierShippingSearch";
import type { CartItem } from "../_store/cartStore";

// =============================================================================
// TENANT PORTAL CLIENT — $10k Architecture
// =============================================================================

type ExtendedTenant = Tenant & {
  whatsappNumber?: string | null;
  contactEmail?: string | null;
  instagramHandle?: string | null;
  backgroundImageUrl?: string | null;
  aboutText?: string | null;
  catalogTitle?: string | null;
  catalogSubtitle?: string | null;
  footerText?: string | null;
  midtransClientKey?: string | null;
  midtransIsProduction?: boolean;
  themeConfig?: any;
  storefrontTaxRate?: number | null;
  paymentMethods?: Array<{
    id: string;
    method: "CASH" | "TRANSFER" | "QRIS" | "CREDIT";
    label: string;
    bankName: string | null;
    accountNumber: string | null;
    accountHolder: string | null;
    qrisImageUrl: string | null;
    instructions: string | null;
    requireProof: boolean;
  }>;
  b2bAccessInvalid?: boolean;
  b2bProfile?: {
    accessToken: string;
    customer: {
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      address: string | null;
      tier: "WHOLESALE_SILVER" | "WHOLESALE_GOLD";
    };
    contract: {
      contractNumber: string;
      endDate: string | null;
      allowCredit: boolean;
      paymentTermsDays: number | null;
    };
    recentOrders: Array<{
      id: string;
      code: string;
      issuedAt: string;
      grandTotal: number;
      purchaseOrderReference: string | null;
      items: CartItem[];
    }>;
  } | null;
};

type StorefrontProduct = Product & {
  recipes?: Array<{ storefrontGrindOptions: StorefrontGrindSize[] }>;
};

interface TenantPortalClientProps {
  tenant: ExtendedTenant & { products: StorefrontProduct[]; offerings: StorefrontOffering[] };
  isPreviewMode?: boolean;
}

const defaultCourierShipping: CourierShippingState = {
  destinationToken: null,
  shippingQuoteToken: null,
  selectedRate: null,
  shippingCost: 0,
};

export function TenantPortalClient({ tenant, isPreviewMode }: TenantPortalClientProps) {
  const cart = useCartStore();
  const hasHydrated = useCartStore((state) => state.hasHydrated);
  const [isCartOpen, setIsCartOpen] = useState(false);

  const b2bProfile = tenant.b2bProfile ?? null;
  const cartKey = b2bProfile
    ? `${tenant.subdomain || "storefront"}:b2b:${b2bProfile.customer.id}`
    : tenant.subdomain || "storefront";
  const [customerName, setCustomerName] = useState(b2bProfile?.customer.name ?? "");
  const [customerPhone, setCustomerPhone] = useState(b2bProfile?.customer.phone ?? "");
  const [customerAddress, setCustomerAddress] = useState(b2bProfile?.customer.address ?? "");
  const [purchaseOrderReference, setPurchaseOrderReference] = useState("");
  const defaultShippingMethod = tenant.storefrontPickupEnabled ? "PICKUP" : "LOCAL_DELIVERY";
  const [shippingMethod, setShippingMethod] = useState(defaultShippingMethod);
  const [paymentMethodId, setPaymentMethodId] = useState(tenant.paymentMethods?.[0]?.id || "");
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  // ─── COURIER shipping state ────────────────────────────────────────────
  const [courierShipping, setCourierShippingState] = useState<CourierShippingState>(defaultCourierShipping);
  const [courierRateChangedError, setCourierRateChangedError] = useState<string | null>(null);

  const setCourierShipping = useCallback((state: CourierShippingState) => {
    setCourierShippingState(state);
    setCourierRateChangedError(null);
  }, []);

  const onClearRateChanged = useCallback(() => {
    setCourierRateChangedError(null);
  }, []);

  // Clear COURIER state when switching away from COURIER
  useEffect(() => {
    if (shippingMethod !== "COURIER") {
      setCourierShippingState(defaultCourierShipping);
      setCourierRateChangedError(null);
    }
  }, [shippingMethod]);

  // Build cart items for quote request
  const courierCartItems = (cart.items[cartKey] || []).map((item: any) => ({
    productId: item.productId || null,
    offeringId: item.offeringId || null,
    variantId: item.variantId || null,
    quantity: item.quantity,
  }));

  const themeMode = tenant.themeMode || "light";
  const isDark = themeMode === "dark";
  const iconStyle = tenant.iconStyle || "regular";
  const iconProps = { weight: iconStyle as "thin" | "light" | "regular" | "bold" | "fill" | "duotone" };

  let iconStroke = 2;
  if (iconStyle === "thin") iconStroke = 1;
  if (iconStyle === "light") iconStroke = 1.5;
  if (iconStyle === "bold") iconStroke = 3;

  // ─── Content (with fallbacks) ─────────────────────────────────────────
  const heroGreeting = tenant.heroText || `Selamat datang di ${tenant.name}`;
  const aboutText = tenant.aboutText || `Portal resmi ${tenant.name}. Akses katalog kopi spesialti eksklusif kami.`;
  const catalogTitle = tenant.catalogTitle || "Katalog Produk";
  const catalogSubtitle = tenant.catalogSubtitle || "Kopi yang dikurasi dan dipanggang untuk konsistensi.";
  const footerText = tenant.footerText || "Hak cipta dilindungi.";

  // ─── Contact Links ────────────────────────────────────────────────────
  let waLink = "";
  if (tenant.whatsappNumber) {
    let cleanWa = tenant.whatsappNumber.replace(/\D/g, '');
    if (cleanWa.startsWith('0')) cleanWa = '62' + cleanWa.substring(1);
    waLink = `https://wa.me/${cleanWa}`;
  }
  const emailLink = tenant.contactEmail ? `mailto:${tenant.contactEmail}` : null;
  const igLink = tenant.instagramHandle ? `https://instagram.com/${tenant.instagramHandle.replace('@', '')}` : null;

  // ─── Persist customer info ────────────────────────────────────────────
  // Kunci diberi namespace per tenant: sebelumnya kunci global
  // ("ros_customer_name") dipakai bersama semua toko sehingga data pelanggan
  // satu tenant menimpa/muncul di portal tenant lain.
  const storagePrefix = `ros:${tenant.subdomain || "storefront"}`;

  useEffect(() => {
    void useCartStore.persist.rehydrate();
    if (b2bProfile) {
      setCustomerName(b2bProfile.customer.name);
      setCustomerPhone(b2bProfile.customer.phone ?? "");
      setCustomerAddress(b2bProfile.customer.address ?? "");
      return;
    }
    const savedName = localStorage.getItem(`${storagePrefix}:name`);
    const savedPhone = localStorage.getItem(`${storagePrefix}:phone`);
    const savedAddress = localStorage.getItem(`${storagePrefix}:address`);
    const savedShipping = localStorage.getItem(`${storagePrefix}:shipping`);
    if (savedName) setCustomerName(savedName);
    if (savedPhone) setCustomerPhone(savedPhone);
    if (savedAddress) setCustomerAddress(savedAddress);
    const savedAllowed = savedShipping === "PICKUP" ? tenant.storefrontPickupEnabled : tenant.storefrontDeliveryEnabled;
    if (savedShipping && savedAllowed) setShippingMethod(savedShipping);
  }, [b2bProfile, storagePrefix, tenant.storefrontDeliveryEnabled, tenant.storefrontPickupEnabled]);

  useEffect(() => {
    if (!b2bProfile && customerName) localStorage.setItem(`${storagePrefix}:name`, customerName);
    if (!b2bProfile && customerPhone) localStorage.setItem(`${storagePrefix}:phone`, customerPhone);
    if (customerAddress) localStorage.setItem(`${storagePrefix}:address`, customerAddress);
    if (shippingMethod) localStorage.setItem(`${storagePrefix}:shipping`, shippingMethod);
  }, [b2bProfile, customerName, customerPhone, customerAddress, shippingMethod, storagePrefix]);

  // ─── Cart Actions ─────────────────────────────────────────────────────
  const handleAddToCart = (
    product: Product,
    grindSize?: StorefrontGrindSize,
    customGrindLabel: string | null = null,
  ) => {
    const storefrontProduct = product as StorefrontProduct;
    const resolvedGrindSize = grindSize
      ?? storefrontProduct.recipes?.[0]?.storefrontGrindOptions[0]
      ?? "WHOLE_BEAN";
    cart.addItem(cartKey, {
      id: storefrontLineId(product.id, resolvedGrindSize, customGrindLabel),
      productId: product.id,
      code: product.code,
      name: product.name,
      imageUrl: product.imageUrl,
      price: Number(product.price || 0),
      basePrice: Number((product as any).price || 0),
      priceBreaks: (product as any).b2bPriceBreaks ?? [],
      grindSize: resolvedGrindSize,
      customGrindLabel,
    });
    setIsCartOpen(true);
  };

  const handleAddOfferingToCart = (
    offering: StorefrontOffering,
    variant: StorefrontOffering["variants"][number],
    grindSize?: StorefrontGrindSize,
    customGrindLabel: string | null = null,
  ) => {
    const resolvedGrindSize = grindSize ?? offering.grindOptions[0] ?? "WHOLE_BEAN";
    cart.addItem(cartKey, {
      id: offeringLineId(offering.id, variant.id, resolvedGrindSize, customGrindLabel),
      productId: null,
      offeringId: offering.id,
      variantId: variant.id,
      code: offering.code,
      name: offering.name,
      imageUrl: offering.imageUrl,
      price: Number(variant.unitPrice || 0),
      grindSize: resolvedGrindSize,
      customGrindLabel,
      packageName: variant.packageName,
      netWeightGrams: Number(variant.netWeightGrams || 0),
      roastLevel: offering.roastLevel ?? null,
    });
    setIsCartOpen(true);
  };

  // ─── Checkout ─────────────────────────────────────────────────────────
  const handleCheckout = async () => {
    if (isCheckingOut) return;
    if (isPreviewMode) {
      toast.error("Checkout dinonaktifkan dalam mode preview.");
      return;
    }
    if (!customerName || !customerPhone || (shippingMethod !== "PICKUP" && !customerAddress)) {
      toast.error("Mohon lengkapi Nama, Nomor HP, dan alamat jika pesanan dikirim.");
      return;
    }
    if (tenant.paymentMethods?.length && !paymentMethodId) {
      toast.error("Mohon pilih metode pembayaran.");
      return;
    }
    // Validate COURIER has required tokens
    if (shippingMethod === "COURIER") {
      if (!courierShipping.destinationToken || !courierShipping.shippingQuoteToken) {
        toast.error("Mohon pilih tujuan dan layanan pengiriman terlebih dahulu.");
        return;
      }
    }

    try {
      setIsCheckingOut(true);
      const checkoutPayload: Record<string, any> = {
        customerName,
        customerPhone,
        customerAddress: customerAddress || "Ambil di roastery",
        shippingMethod,
        paymentMethodId: paymentMethodId || undefined,
        items: cart.items[cartKey] || [],
        ...(b2bProfile ? {
          b2bAccessToken: b2bProfile.accessToken,
          purchaseOrderReference: purchaseOrderReference.trim() || undefined,
        } : {}),
      };

      // Wire COURIER tokens
      if (shippingMethod === "COURIER") {
        checkoutPayload.shippingQuoteToken = courierShipping.shippingQuoteToken;
        checkoutPayload.destinationToken = courierShipping.destinationToken;
      }

      const idempotencyStorageKey = `ros_checkout_operation_${cartKey}`;
      const fingerprint = JSON.stringify(checkoutPayload);
      let operationKey = crypto.randomUUID();
      try {
        const saved = JSON.parse(sessionStorage.getItem(idempotencyStorageKey) || "null") as {
          fingerprint?: string;
          operationKey?: string;
        } | null;
        if (saved?.fingerprint === fingerprint && saved.operationKey) operationKey = saved.operationKey;
        else sessionStorage.setItem(idempotencyStorageKey, JSON.stringify({ fingerprint, operationKey }));
      } catch {
        sessionStorage.setItem(idempotencyStorageKey, JSON.stringify({ fingerprint, operationKey }));
      }
      const res = await fetch(`/api/tenant/${tenant.subdomain}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": operationKey },
        body: fingerprint,
      });

      // Handle SHIPPING_RATE_CHANGED (409)
      if (res.status === 409) {
        const errorData = await res.json();
        if (errorData.code === "SHIPPING_RATE_CHANGED") {
          setCourierRateChangedError(errorData.error || "Harga ongkir berubah. Silakan pilih ulang.");
          setCourierShippingState(defaultCourierShipping);
          toast.error("Harga ongkir telah berubah. Silakan pilih ulang tujuan dan layanan.");
          return;
        }
      }

      if (!res.ok) {
        const errorData = await res.json();
        toast.error("Gagal merekam pesanan: " + (errorData.error || "Terjadi kesalahan server."));
        return;
      }

      const data = await res.json();
      sessionStorage.removeItem(idempotencyStorageKey);
      const invoiceCode = data.invoice?.code || "-";

      if (data.orderUrl) {
        cart.clearCart(cartKey);
        setIsCartOpen(false);
        window.location.assign(data.orderUrl);
        return;
      }

      let text = `Halo Admin ${tenant.name},\nSaya ingin memesan (Order B2B):\n\n`;
      text += `*No. Ref:* ${invoiceCode}\n`;
      let shipText = 'Kurir Lokal (Lalamove/Gojek)';
      if (shippingMethod === 'STORE_COURIER') shipText = 'Kurir Pribadi Toko';
      else if (shippingMethod === 'COURIER') shipText = 'Ekspedisi (JNE/J&T/Sicepat)';
      text += `*Metode Pengiriman:* ${shipText}\n`;
      text += `*Data Pembeli:*\nNama: ${customerName}\nNo. HP: ${customerPhone}\n`;
      text += `Alamat Pengiriman: ${customerAddress}\n`;
      text += `\n*Detail Pesanan:*\n`;
      const tenantItems = cart.items[cartKey] || [];
      tenantItems.forEach((item: any, idx: number) => {
        text += `${idx + 1}. ${item.name} - ${item.quantity}x @ Rp ${item.price.toLocaleString("id-ID")} = Rp ${(item.quantity * item.price).toLocaleString("id-ID")}\n`;
      });
      text += `\nTotal Harga: Rp ${cart.getTotalPrice(cartKey).toLocaleString("id-ID")}\n\nMohon diinformasikan ketersediaan dan ongkos kirim. Terima kasih.`;

      let cleanWa = tenant.whatsappNumber?.replace(/\D/g, '') || '';
      if (cleanWa.startsWith('0')) cleanWa = '62' + cleanWa.substring(1);

      if (!cleanWa) {
        cart.clearCart(cartKey);
        setIsCartOpen(false);
        toast.success(`Pesanan terekam (Ref: ${invoiceCode}) tapi nomor WhatsApp admin belum diatur di sistem.`);
        return;
      }

      window.open(`https://wa.me/${cleanWa}?text=${encodeURIComponent(text)}`, '_blank');
      cart.clearCart(cartKey);
      setIsCartOpen(false);
    } catch (error) {
      console.error(error);
      toast.error("Terjadi kesalahan sistem saat memproses checkout.");
    } finally {
      setIsCheckingOut(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────
  const taxRate = Number(tenant.storefrontTaxRate || 0);

  const themeProps = {
    tenant, cart, cartKey, isCartOpen, setIsCartOpen, customerName, setCustomerName, customerPhone, setCustomerPhone,
    customerAddress, setCustomerAddress, shippingMethod, setShippingMethod, handleAddToCart, handleAddOfferingToCart, handleCheckout, mounted: hasHydrated, heroGreeting, aboutText,
    catalogTitle, catalogSubtitle, footerText, waLink, emailLink, igLink, iconProps, iconStroke, isDark,
    isCheckingOut,
    paymentMethodId,
    setPaymentMethodId,
    courierShipping,
    setCourierShipping,
    courierShippingCartItems: courierCartItems,
    courierRateChangedError,
    onClearRateChanged,
    taxRate,
    purchaseOrderReference,
    setPurchaseOrderReference,
    b2bProfile,
  };

  return <>
    {isPreviewMode ? (
      <div role="status" aria-live="polite" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs font-semibold text-amber-900">
        Mode Preview — Anda melihat draft yang belum dipublish. Toko publik tetap tayang; checkout dinonaktifkan di sini.
      </div>
    ) : null}
    {tenant.b2bAccessInvalid ? (
      <div role="alert" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-900">
        Link partner tidak valid atau sudah kedaluwarsa. Katalog retail tetap tersedia; minta link baru dari roastery.
      </div>
    ) : null}
    {b2bProfile ? (
      <aside className="border-b border-emerald-800 bg-emerald-950 px-4 py-4 text-emerald-50" aria-label="Akun partner B2B">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-300">Portal Partner</p>
            <p className="font-semibold">{b2bProfile.customer.name} · {b2bProfile.contract.contractNumber}</p>
            <p className="text-xs text-emerald-200">
              {b2bProfile.customer.tier.replace("WHOLESALE_", "Tier ")}
              {b2bProfile.contract.allowCredit ? ` · Kredit ${b2bProfile.contract.paymentTermsDays} hari` : " · Pembayaran langsung"}
            </p>
          </div>
          {b2bProfile.recentOrders.some((order) => order.items.length > 0) ? (
            <div className="flex flex-wrap gap-2" aria-label="Pesan ulang">
              {b2bProfile.recentOrders.filter((order) => order.items.length > 0).slice(0, 3).map((order) => (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => {
                    cart.replaceCart(cartKey, order.items);
                    setIsCartOpen(true);
                    toast.success(`Pesanan ${order.code} dimuat ulang dengan harga kontrak terbaru.`);
                  }}
                  className="min-h-10 rounded-lg border border-emerald-700 bg-emerald-900 px-3 py-2 text-xs font-bold hover:bg-emerald-800"
                >
                  Pesan lagi {order.code}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </aside>
    ) : null}
    <UniversalTheme {...themeProps} />
  </>;
}
