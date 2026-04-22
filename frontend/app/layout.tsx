import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EduKit PA Control",
  description: "PID dashboard for the Festo Didactic EduKit PA"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
