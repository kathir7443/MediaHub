import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl } from "@workspace/api-client-react";

// When the frontend and API are hosted on different origins (e.g. Vercel +
// Render), set VITE_API_BASE_URL to the full origin of the API server so
// every /api/... fetch is routed to the correct backend.
//
//   Vercel env var example:
//     VITE_API_BASE_URL = https://mediahub-api-3nww.onrender.com
//
// When this var is absent (Replit, local dev, same-origin deployment), all
// requests use relative /api/... paths through the shared proxy as normal.
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
if (apiBaseUrl) setBaseUrl(apiBaseUrl);

import { setBaseUrl } from "@workspace/api-client-react";

setBaseUrl(import.meta.env.VITE_API_URL);

createRoot(document.getElementById("root")!).render(<App />);
