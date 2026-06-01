import type { Metadata } from "next";
import Link from "next/link";

// Offline fallback shell, served by the service worker when a navigation fails
// with no network. Deliberately top-level (NOT under the (dashboard) auth group)
// and free of any data/auth dependency, so it renders with zero network.
export const metadata: Metadata = {
  title: "Offline — cortextOS",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#0F0F0F] px-6 text-center text-neutral-200">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icons/icon-192.png"
        alt="cortextOS"
        width={88}
        height={88}
        className="rounded-2xl"
      />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-neutral-50">Du er offline</h1>
        <p className="max-w-sm text-sm text-neutral-400">
          cortextOS-dashbordet trenger nett for å hente sanntidsdata. Sjekk
          tilkoblingen din og prøv igjen.
        </p>
      </div>
      {/*
        Server-rendered Link → emits a plain <a href="/"> in the HTML, so the
        retry works even when offline with no route JS hydrated (codex P2): the
        anchor navigates home, the SW re-attempts the network, and serves the
        real page once back online. No client component = no hydration dependency.
      */}
      <Link
        href="/"
        className="rounded-lg bg-[#D4AF37] px-5 py-2 text-sm font-medium text-[#0F0F0F] transition-opacity hover:opacity-90"
      >
        Prøv igjen
      </Link>
    </main>
  );
}
