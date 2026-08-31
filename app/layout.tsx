import { JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

// The ledger register. Loaded as a CSS variable rather than applied to body,
// so it can be scoped to headings, timestamps and ids only — see globals.css.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "Revenue Recovery Agent",
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
