import type { Metadata, Viewport } from "next";
import Prewarm from "@/components/Prewarm";
import ServiceWorker from "@/components/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "QRDrop — send files instantly, no upload",
  description:
    "Scan a QR code and transfer files device-to-device over an encrypted peer-to-peer connection. No cloud, no account, no install.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "QRDrop",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#070b14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <div className="bg" aria-hidden>
          <span />
          <span />
        </div>
        <Prewarm />
        <ServiceWorker />
        {children}
      </body>
    </html>
  );
}
