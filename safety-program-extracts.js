(function attachPublicSafetyProgramExtracts() {
  "use strict";

  const library = window.SafetyOpsProgramLibrary;
  if (!library) return;
  library.extracts ||= {};
  library.meta.extraction ||= {
    extracted: 0,
    imageOnly: 0,
    ocrRequired: 0
  };
})();
