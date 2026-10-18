# Safari chat focus and asset cache fix

Chat now fixes the body only while the chat screen is open and clips overflow on its non-scrolling ancestors. Message history retains its own scrolling area. This prevents focus-driven ancestor scrolling from displacing the composer.

The service worker now matches complete asset URLs, including version queries. The build precaches the same versioned JavaScript and CSS URLs referenced by HTML. A request for a newer build no longer receives an older cached asset. Exact-version offline caching remains available.

Existing installations may load once under the previous service worker; after the updated worker activates, reload the page to use the new assets.

Validation on 2026-10-19: 85 Node tests and 46 Python tests passed; the production build generated 14 assets. The compiled worker's install list was checked against the actual JavaScript/CSS SHA-256 version queries in HTML. This public build has not received a separate iPhone device acceptance test.

Only the stylesheet, service worker, build script, synthetic cache tests and this note changed. Application branding, deployment configuration, environment examples, backend code and image assets remain unchanged.
