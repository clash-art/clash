import "./globals.css";
import "./lib/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { ThemeProvider } from "@clash/web-ui/components/ThemeProvider";
import { router } from "./router";
import { installViteRuntimeConfig } from "./runtime-env";
import { installWebTelemetry } from "./lib/telemetry";
import { installTimelineRenderCompositionRoot } from "./lib/timeline-render/composition-root";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

installViteRuntimeConfig(import.meta.env);
// After runtime config: telemetry is local/Desktop only and targets the Host.
installWebTelemetry({ router });
installTimelineRenderCompositionRoot();

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
