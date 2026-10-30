import type { Metadata } from "next";
import { Inter, Newsreader } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

/**
 * The origin every canonical and Open Graph URL is resolved against.
 *
 * Separate from `SITE_ORIGIN`, and both are needed: `SITE_ORIGIN` is a server
 * secret-adjacent value used for the server-action origin check, while this
 * one is inlined into the client bundle because `metadataBase` is evaluated
 * where metadata is rendered. Setting one and not the other is the common
 * mistake, which is why `docs/DEPLOYMENT.md` lists them together.
 *
 * Validated rather than handed to `new URL` directly: a placeholder left in
 * `.env.production.local` otherwise fails the build with `TypeError: Invalid
 * URL` and no indication of which variable produced it.
 */
function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return "https://lcci.com.pk";

  try {
    new URL(configured);
    return configured;
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL is not a valid URL: ${JSON.stringify(configured)}. ` +
        "It must include the scheme, for example https://lcci.com.pk. Leave it " +
        "unset to fall back to the production domain.",
    );
  }
}

const SITE_URL = siteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // The legacy site served one <title> for every page. The template makes a
  // unique title structurally unavoidable rather than a thing editors remember.
  title: {
    default:
      "Lahore Chamber of Commerce & Industry — the voice of Lahore's business community",
    template: "%s | Lahore Chamber of Commerce & Industry",
  },
  description:
    "The Lahore Chamber of Commerce & Industry represents over 20,000 businesses. Join or renew online, request certificates of origin and attestation, search the member directory, and follow the chamber's advocacy.",
  openGraph: {
    type: "website",
    siteName: "Lahore Chamber of Commerce & Industry",
    locale: "en_PK",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} ${newsreader.variable}`}>
      <body className="antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink-950 focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-white"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
