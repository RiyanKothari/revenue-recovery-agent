import localFont from "next/font/local";
import { Providers } from "./providers";
import "./globals.css";

// The ledger register. Loaded as a CSS variable rather than applied to body,
// so it can be scoped to headings, timestamps and ids only — see globals.css.
//
// Self-hosted from app/fonts (JetBrains Mono, SIL OFL 1.1, from the
// @fontsource package) rather than fetched from Google at build time. The
// Google fetch made every build depend on the network: one CI run failed
// inside next/font with nothing changed, and a re-run passed. A build that
// can fail on someone else's server is not a reproducible build.
const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: {
    default: "Revenue Recovery — Live",
    template: "%s",
  },
  description: "Track 03 — AI Revenue Recovery | Razorpay AI Buildathon",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
