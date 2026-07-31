(function loadLocalPrivateTenant() {
  "use strict";

  const localHosts = new Set(["127.0.0.1", "localhost"]);
  if (
    !localHosts.has(window.location.hostname) ||
    window.SAFETYOPS_ENABLE_LOCAL_PRIVATE_OVERLAY !== true
  ) return;

  const sources = [
    "private/safety-programs.js",
    "private/safety-source-lineage.js",
    "private/safety-program-extracts.js"
  ];
  if (window.SAFETYOPS_ENABLE_LOCAL_COMPANY_FIXTURE === true) {
    sources.unshift("private/company-data.js", "private/osha-tenant-overrides.js");
  }
  sources.forEach((source) => {
    document.write(`<script src="${source}"><\/script>`);
  });
})();
