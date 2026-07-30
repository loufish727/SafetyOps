(function seedSafetyOpsData() {
  const locations = [
    {
      id: "north",
      name: "North Plant",
      short: "North",
      city: "Portland, OR",
      type: "Manufacturing",
      manager: "Maya Chen",
      people: 42,
      training: 96,
      inspections: 91,
      openActions: 4,
      risk: "Low",
      accent: "#24a37a"
    },
    {
      id: "west",
      name: "West Distribution",
      short: "West",
      city: "Seattle, WA",
      type: "Operations",
      manager: "Devin Brooks",
      people: 31,
      training: 88,
      inspections: 82,
      openActions: 7,
      risk: "Watch",
      accent: "#e0a12b"
    },
    {
      id: "south",
      name: "South Field Service",
      short: "South",
      city: "Phoenix, AZ",
      type: "Operations",
      manager: "Avery Patel",
      people: 24,
      training: 93,
      inspections: 89,
      openActions: 3,
      risk: "Low",
      accent: "#3c8ce7"
    },
    {
      id: "central",
      name: "Central Fabrication",
      short: "Central",
      city: "Denver, CO",
      type: "Operations",
      manager: "Jordan Lee",
      people: 28,
      training: 84,
      inspections: 76,
      openActions: 9,
      risk: "Elevated",
      accent: "#df655d"
    },
    {
      id: "east",
      name: "East Warehouse",
      short: "East",
      city: "Columbus, OH",
      type: "Operations",
      manager: "Sam Rivera",
      people: 17,
      training: 98,
      inspections: 94,
      openActions: 2,
      risk: "Low",
      accent: "#805ad5"
    }
  ];

  const tasks = [
    {
      id: "task-1",
      type: "Inspection",
      title: "Weekly powered equipment inspection",
      locationId: "central",
      owner: "Jordan Lee",
      due: "Today · 10:30 AM",
      priority: "High",
      progress: 25,
      status: "In progress"
    },
    {
      id: "task-2",
      type: "Training",
      title: "Lockout/tagout refresher",
      locationId: "west",
      owner: "12 workers",
      due: "Today · 3:00 PM",
      priority: "Medium",
      progress: 67,
      status: "Assigned"
    },
    {
      id: "task-3",
      type: "Corrective action",
      title: "Replace damaged loading-dock guardrail",
      locationId: "west",
      owner: "Devin Brooks",
      due: "Overdue · 2 days",
      priority: "Critical",
      progress: 50,
      status: "Overdue"
    },
    {
      id: "task-4",
      type: "Document",
      title: "Acknowledge revised heat illness plan",
      locationId: "south",
      owner: "5 workers",
      due: "Tomorrow",
      priority: "Medium",
      progress: 79,
      status: "Awaiting acknowledgement"
    },
    {
      id: "task-5",
      type: "Inspection",
      title: "Emergency eyewash station check",
      locationId: "north",
      owner: "Maya Chen",
      due: "Tomorrow · 8:00 AM",
      priority: "Low",
      progress: 0,
      status: "Scheduled"
    }
  ];

  const inspectionTemplates = [
    {
      id: "tpl-daily",
      name: "Daily workplace inspection",
      category: "General",
      questions: 18,
      frequency: "Daily",
      used: 142,
      lastUsed: "8 minutes ago"
    },
    {
      id: "tpl-jha",
      name: "Job hazard analysis",
      category: "Pre-task",
      questions: 12,
      frequency: "As needed",
      used: 87,
      lastUsed: "42 minutes ago"
    },
    {
      id: "tpl-forklift",
      name: "Powered industrial truck pre-use",
      category: "Equipment",
      questions: 21,
      frequency: "Per shift",
      used: 311,
      lastUsed: "1 hour ago"
    },
    {
      id: "tpl-toolbox",
      name: "Toolbox talk attendance",
      category: "Training",
      questions: 6,
      frequency: "Weekly",
      used: 56,
      lastUsed: "Yesterday"
    },
    {
      id: "tpl-eyewash",
      name: "Emergency eyewash inspection",
      category: "Emergency",
      questions: 14,
      frequency: "Weekly",
      used: 38,
      lastUsed: "2 days ago"
    },
    {
      id: "tpl-incident",
      name: "Incident and near-miss intake",
      category: "Incident",
      questions: 16,
      frequency: "As needed",
      used: 19,
      lastUsed: "3 days ago"
    }
  ];

  const inspections = [
    {
      id: "INSP-1042",
      template: "Daily workplace inspection",
      locationId: "north",
      assignee: "Maya Chen",
      score: 96,
      status: "Complete",
      due: "Jul 30",
      findings: 1
    },
    {
      id: "INSP-1041",
      template: "Powered industrial truck pre-use",
      locationId: "central",
      assignee: "Jordan Lee",
      score: 78,
      status: "Action needed",
      due: "Jul 30",
      findings: 3
    },
    {
      id: "INSP-1040",
      template: "Emergency eyewash inspection",
      locationId: "west",
      assignee: "Devin Brooks",
      score: null,
      status: "Scheduled",
      due: "Jul 31",
      findings: 0
    },
    {
      id: "INSP-1039",
      template: "Job hazard analysis",
      locationId: "south",
      assignee: "Avery Patel",
      score: 100,
      status: "Complete",
      due: "Jul 29",
      findings: 0
    }
  ];

  const courses = [
    {
      id: "course-loto",
      name: "Lockout/tagout essentials",
      category: "Energy control",
      duration: "12 min",
      format: "Micro-course",
      assigned: 28,
      complete: 82,
      due: "Aug 2",
      languages: 3
    },
    {
      id: "course-hazcom",
      name: "Hazard communication",
      category: "OSHA core",
      duration: "18 min",
      format: "Course + quiz",
      assigned: 142,
      complete: 94,
      due: "Aug 15",
      languages: 4
    },
    {
      id: "course-heat",
      name: "Heat illness prevention",
      category: "Seasonal",
      duration: "9 min",
      format: "Briefing",
      assigned: 71,
      complete: 89,
      due: "Aug 1",
      languages: 2
    },
    {
      id: "course-forklift",
      name: "Forklift operator refresher",
      category: "Equipment",
      duration: "24 min",
      format: "Course + verification",
      assigned: 19,
      complete: 74,
      due: "Aug 8",
      languages: 2
    }
  ];

  const people = [
    { id: "p1", name: "Maya Chen", initials: "MC", role: "Location manager", locationId: "north", training: 100, credentials: "5 current", status: "Current" },
    { id: "p2", name: "Devin Brooks", initials: "DB", role: "Safety lead", locationId: "west", training: 92, credentials: "4 current", status: "Current" },
    { id: "p3", name: "Avery Patel", initials: "AP", role: "Field supervisor", locationId: "south", training: 96, credentials: "1 due soon", status: "Due soon" },
    { id: "p4", name: "Jordan Lee", initials: "JL", role: "Plant manager", locationId: "central", training: 84, credentials: "1 expired", status: "Expired" },
    { id: "p5", name: "Sam Rivera", initials: "SR", role: "Warehouse lead", locationId: "east", training: 100, credentials: "3 current", status: "Current" },
    { id: "p6", name: "Noah Williams", initials: "NW", role: "Technician", locationId: "west", training: 75, credentials: "2 current", status: "Training due" },
    { id: "p7", name: "Elena Garcia", initials: "EG", role: "Operator", locationId: "central", training: 88, credentials: "2 current", status: "Current" }
  ];

  const incidents = [
    {
      id: "INC-026",
      title: "Forklift contacted storage rack",
      type: "Property damage",
      severity: "High",
      locationId: "central",
      reportedBy: "Elena Garcia",
      date: "Jul 28, 2026",
      status: "Investigation",
      daysOpen: 2
    },
    {
      id: "INC-025",
      title: "Slip near receiving entrance",
      type: "Near miss",
      severity: "Medium",
      locationId: "west",
      reportedBy: "Noah Williams",
      date: "Jul 25, 2026",
      status: "Actions open",
      daysOpen: 5
    },
    {
      id: "INC-024",
      title: "Minor hand laceration",
      type: "First aid",
      severity: "Low",
      locationId: "north",
      reportedBy: "Maya Chen",
      date: "Jul 18, 2026",
      status: "Closed",
      daysOpen: 1
    }
  ];

  const actions = [
    { id: "ACT-089", title: "Replace loading-dock guardrail", source: "INSP-1031", owner: "Devin Brooks", locationId: "west", due: "Jul 28", priority: "Critical", status: "Overdue" },
    { id: "ACT-088", title: "Repaint pedestrian separation lines", source: "INSP-1034", owner: "Jordan Lee", locationId: "central", due: "Jul 31", priority: "High", status: "In progress" },
    { id: "ACT-087", title: "Update forklift traffic plan", source: "INC-026", owner: "Jordan Lee", locationId: "central", due: "Aug 2", priority: "High", status: "Open" },
    { id: "ACT-086", title: "Post revised heat plan at field trailer", source: "DOC-014", owner: "Avery Patel", locationId: "south", due: "Aug 1", priority: "Medium", status: "Open" },
    { id: "ACT-085", title: "Restock eyewash inspection tags", source: "INSP-1028", owner: "Maya Chen", locationId: "north", due: "Aug 3", priority: "Low", status: "Open" }
  ];

  const documents = [
    { id: "DOC-014", name: "Heat illness prevention plan", type: "Policy", version: "v3.2", owner: "Corporate Safety", updated: "Jul 24, 2026", review: "Jul 24, 2027", acknowledgement: 79, status: "Acknowledgement open" },
    { id: "DOC-013", name: "Emergency action plan", type: "Program", version: "v5.0", owner: "Corporate Safety", updated: "Jun 18, 2026", review: "Dec 18, 2026", acknowledgement: 100, status: "Current" },
    { id: "DOC-012", name: "Powered industrial truck SOP", type: "Procedure", version: "v2.4", owner: "Operations", updated: "May 10, 2026", review: "May 10, 2027", acknowledgement: 96, status: "Current" },
    { id: "DOC-011", name: "Incident investigation standard", type: "Procedure", version: "v1.8", owner: "Corporate Safety", updated: "Apr 2, 2026", review: "Oct 2, 2026", acknowledgement: 100, status: "Current" },
    { id: "DOC-010", name: "Respiratory protection program", type: "Program", version: "v4.1", owner: "Industrial Hygiene", updated: "Mar 14, 2026", review: "Sep 14, 2026", acknowledgement: 92, status: "Review due soon" }
  ];

  const activity = [
    { id: "ev1", icon: "✓", tone: "green", text: "Maya completed the North daily inspection at 96%.", time: "8 min ago" },
    { id: "ev2", icon: "!", tone: "amber", text: "Jordan opened three findings from the Central forklift inspection.", time: "34 min ago" },
    { id: "ev3", icon: "↗", tone: "blue", text: "Lockout/tagout refresher was assigned to 12 West workers.", time: "1 hr ago" },
    { id: "ev4", icon: "•", tone: "purple", text: "Heat illness plan v3.2 was published for acknowledgement.", time: "Yesterday" }
  ];

  window.SafetyOpsData = {
    company: {
      id: "safetyops-demo",
      name: "SafetyOps Demo Company",
      plan: "Prototype workspace",
      activeWorkers: 142,
      daysWithoutRecordable: 41
    },
    currentUser: {
      name: "Alex Morgan",
      initials: "AM",
      role: "Corporate safety manager"
    },
    locations,
    tasks,
    inspectionTemplates,
    inspections,
    courses,
    people,
    incidents,
    actions,
    documents,
    activity
  };
})();
