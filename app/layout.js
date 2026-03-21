import "./globals.css";

export const metadata = {
  title: "Risk %10 / TP 2x",
  description: "Yeni coinlere %10 risk ile giren paper-trade paneli"
};

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
