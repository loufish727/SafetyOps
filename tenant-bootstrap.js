(function loadLocalPrivateTenant() {
  "use strict";

  const localHosts = new Set(["127.0.0.1", "localhost"]);
  if (!localHosts.has(window.location.hostname)) return;

  [
    "private/company-data.js",
    "private/osha-tenant-overrides.js",
    "private/safety-programs.js",
    "private/safety-source-lineage.js",
    "private/safety-program-extracts.js"
  ].forEach((source) => {
    document.write(`<script src="${source}"><\/script>`);
  });
})();
