import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Genexa Operations",
  applicationName: "Genexa Operations",
  description: "Genexa Scaling internal operating system",
  robots: { index: false, follow: false },
  // iOS home screen: full-screen app with the name under the icon.
  appleWebApp: { capable: true, title: "Genexa Operations", statusBarStyle: "black-translucent" },
};

// viewportFit "cover" + the safe-area padding in globals.css keep content clear of the notch and
// home indicator when the app runs full-screen from the home screen.
export const viewport: Viewport = { themeColor: "#111110", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
