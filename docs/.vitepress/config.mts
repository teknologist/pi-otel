import { defineConfig } from "vitepress";

export default defineConfig({
  title: "pi-otel",
  description:
    "OpenTelemetry tracing, metrics, and logs for the pi coding agent.",
  base: "/pi-otel/",
  cleanUrls: true,
  ignoreDeadLinks: true,
  appearance: "dark",
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "User Guide", link: "/user-guide" },
      { text: "Configuration", link: "/configuration" },
      { text: "Backends", link: "/backends" },
      { text: "Extensibility", link: "/extensibility" },
      { text: "GitHub", link: "https://github.com/NikiforovAll/pi-otel" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "User Guide", link: "/user-guide" },
          { text: "Configuration", link: "/configuration" },
          { text: "Backends", link: "/backends" },
          { text: "Extensibility", link: "/extensibility" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/NikiforovAll/pi-otel" },
    ],
    editLink: {
      pattern: "https://github.com/NikiforovAll/pi-otel/edit/main/docs/:path",
    },
  },
});
