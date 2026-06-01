import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest). Makes the dashboard an
// installable PWA — Android/Chrome read this for "Add to Home screen" +
// standalone display; iOS uses it for the app name + display mode (the
// home-screen icon itself comes from apple-touch-icon, set in layout metadata).
//
// `display: standalone` drops the browser chrome so it opens like a native app.
// theme/background use the dashboard's near-black so the splash + status bar
// match the gold-on-dark UI.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "cortextOS Dashboard",
    short_name: "cortextOS",
    description: "cortextOS agent orchestration dashboard",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0F0F0F",
    theme_color: "#0F0F0F",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
