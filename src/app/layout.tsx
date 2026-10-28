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

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://lcci.com.pk";

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
