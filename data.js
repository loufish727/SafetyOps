(function initializeSafetyOpsData() {
  "use strict";

  // The public application ships with no company, worker, location, incident,
  // training, inspection, or document records. Authenticated tenant data is
  // loaded from Supabase after RLS authorizes the signed-in user.
  window.SafetyOpsData = {
    company: null,
    currentUser: null,
    locations: [],
    tasks: [],
    inspectionTemplates: [],
    inspections: [],
    courses: [],
    people: [],
    incidents: [],
    actions: [],
    documents: [],
    activity: [],
    programAssignments: [],
    programSubmissions: []
  };
})();
