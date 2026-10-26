// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./precision.css";
import Sidebar from "@/components/layout/Sidebar";
import { ToastProvider } from "@/components/shared/ToastProvider";
import DbStatusBanner from "@/components/shared/DbStatusBanner";
import MobileTopBar from "@/components/layout/MobileTopBar";
import MobileTabBar from "@/components/layout/MobileTabBar";
import { getTheme } from "@/lib/theme";
import { ThemeProvider } from "@/components/layout/ThemeContext";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Frontier Command Centre",
  description: "Enterprise AI visibility, compliance audit, and governance",
  icons: {
    icon: [{ url: "/frontier-icon.svg", type: "image/svg+xml" }],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading the request headers keeps every page rendered per request, so the
  // nonce the middleware sets is fresh. Pass it to any <Script> as
  // (await headers()).get('x-nonce'); none needs it today.
  await headers();
  const theme = getTheme();

  return (
    <html lang="en" data-theme={theme === "precision" ? "precision" : undefined}>
      <body
        className={`${inter.variable} ${robotoMono.variable} antialiased bg-gray-50`}
      >
        <ThemeProvider theme={theme}>
          <DbStatusBanner />
          <Sidebar theme={theme} />
          <MobileTopBar theme={theme} />
          <main className="ccc-main ml-0 lg:ml-64 min-h-screen pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
            <ToastProvider>{children}</ToastProvider>
          </main>
          <MobileTabBar />
        </ThemeProvider>
      </body>
    </html>
  );
}
