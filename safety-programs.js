(function seedPublicSafetyProgramLibrary() {
  "use strict";

  window.SafetyOpsProgramLibrary = {
    meta: {
      sourceName: "Company safety library",
      sourceFolderId: null,
      sourceUrl: null,
      sourceCapturedOn: null,
      privacy: "Tenant data loads after authentication",
      ingestionMode: "Create a company or sign in to load its private programs, forms, and source files.",
      counts: {
        programs: 0,
        digitalForms: 0,
        folders: 0,
        looseResources: 0
      },
      extraction: {
        extracted: 0,
        imageOnly: 0,
        ocrRequired: 0
      },
      binaryIngestion: {
        filesVerified: 0,
        totalBytes: 0,
        capturedOn: null,
        storageTarget: "Private Supabase Storage"
      }
    },
    programs: [],
    forms: [],
    folders: [],
    looseResources: [],
    extracts: {}
  };
})();
