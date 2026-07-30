(function attachPublicSafetySourceLineage() {
  "use strict";

  const library = window.SafetyOpsProgramLibrary;
  if (!library) return;
  library.meta.binaryIngestion ||= {
    filesVerified: 0,
    totalBytes: 0,
    capturedOn: null,
    storageTarget: "Private Supabase Storage"
  };
})();
