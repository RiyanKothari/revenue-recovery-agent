import { Providers } from "./providers";

export const metadata = {
  title: "Revenue Recovery Agent",
  description: "Track 03 — AI Revenue Recovery | Razorpay AI Buildathon",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
