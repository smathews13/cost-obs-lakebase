import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// When Vite can't fetch a lazily-imported chunk (stale deployment, new hash),
// it fires this event. Force a hard reload so the user gets the new build.
window.addEventListener("vite:preloadError", () => {
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
