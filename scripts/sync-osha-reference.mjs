import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outputFile = path.resolve(projectRoot, "osha-reference.js");
const manifestFile = path.resolve(projectRoot, "docs", "osha-corpus-manifest.json");

for (const target of [outputFile, manifestFile]) {
  if (!target.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("Refusing to write outside the SafetyOps project.");
  }
}

const apiRoot = "https://www.ecfr.gov/api";
const corePartIds = [
  "1903",
  "1904",
  "1910",
  "1915",
  "1917",
  "1918",
  "1919",
  "1926",
  "1928",
  "1960"
];

const featuredDefinitions = {
  "1904.29": {
    summary: "Establishes the OSHA recordkeeping forms and the basic process for completing them.",
    topics: ["recordkeeping", "OSHA 300", "OSHA 301"],
    priority: "high"
  },
  "1904.32": {
    summary: "Covers annual review, certification, and posting of the injury and illness summary.",
    topics: ["recordkeeping", "annual summary", "posting"],
    priority: "high"
  },
  "1904.39": {
    summary: "Sets time-sensitive reporting duties for fatalities, in-patient hospitalizations, amputations, and losses of an eye.",
    topics: ["incident reporting", "fatality", "hospitalization"],
    priority: "critical"
  },
  "1910.22": {
    summary: "Requires workplaces, walking-working surfaces, and access routes to be maintained in a clean, orderly, and safe condition.",
    topics: ["housekeeping", "walking surfaces", "inspections"],
    priority: "high"
  },
  "1910.28": {
    summary: "Defines when general-industry employers must protect workers from falls and falling objects.",
    topics: ["fall protection", "guardrails", "walking surfaces"],
    priority: "critical"
  },
  "1910.38": {
    summary: "Specifies when an emergency action plan is required and the minimum elements it must contain.",
    topics: ["emergency action plan", "evacuation", "training"],
    priority: "high"
  },
  "1910.95": {
    summary: "Addresses occupational noise exposure, hearing conservation, monitoring, training, and records.",
    topics: ["noise", "hearing conservation", "exposure monitoring"],
    priority: "high"
  },
  "1910.132": {
    summary: "Establishes general personal protective equipment duties, including hazard assessment and training.",
    topics: ["PPE", "hazard assessment", "training"],
    priority: "critical"
  },
  "1910.134": {
    summary: "Requires a written respiratory protection program where respirators are necessary and defines program controls.",
    topics: ["respirators", "written program", "fit testing"],
    priority: "critical"
  },
  "1910.146": {
    summary: "Establishes the permit-required confined-space program for general industry.",
    topics: ["confined space", "permit", "rescue"],
    priority: "critical"
  },
  "1910.147": {
    summary: "Establishes hazardous-energy control requirements for servicing and maintenance activities.",
    topics: ["lockout tagout", "energy control", "training"],
    priority: "critical"
  },
  "1910.151": {
    summary: "Covers medical services, first aid, and suitable flushing facilities for certain corrosive exposures.",
    topics: ["first aid", "eyewash", "medical services"],
    priority: "high"
  },
  "1910.157": {
    summary: "Covers placement, inspection, maintenance, and employee use of portable fire extinguishers.",
    topics: ["fire extinguishers", "inspection", "training"],
    priority: "high"
  },
  "1910.178": {
    summary: "Covers powered industrial truck design, operation, inspection, maintenance, and operator training.",
    topics: ["forklift", "powered industrial truck", "operator training"],
    priority: "critical"
  },
  "1910.212": {
    summary: "Establishes general machine-guarding requirements for hazards created by machinery.",
    topics: ["machine guarding", "point of operation", "equipment"],
    priority: "critical"
  },
  "1910.303": {
    summary: "Provides general requirements for examination, installation, guarding, and use of electrical equipment.",
    topics: ["electrical", "equipment", "guarding"],
    priority: "high"
  },
  "1910.1030": {
    summary: "Establishes controls for occupational exposure to blood and other potentially infectious materials.",
    topics: ["bloodborne pathogens", "exposure control", "training"],
    priority: "high"
  },
  "1910.1200": {
    summary: "Requires chemical hazard classification and communication through labels, safety data sheets, and employee training.",
    topics: ["hazard communication", "SDS", "labels", "training"],
    priority: "critical"
  },
  "1926.20": {
    summary: "Establishes general construction safety and health program responsibilities, including inspections by competent persons.",
    topics: ["construction", "safety program", "competent person"],
    priority: "high"
  },
  "1926.21": {
    summary: "Addresses construction safety training and instruction responsibilities.",
    topics: ["construction", "training", "hazard recognition"],
    priority: "high"
  },
  "1926.50": {
    summary: "Covers medical services, first aid, emergency transport, and flushing facilities in construction.",
    topics: ["construction", "first aid", "eyewash"],
    priority: "high"
  },
  "1926.95": {
    summary: "Establishes construction personal protective equipment requirements.",
    topics: ["construction", "PPE"],
    priority: "critical"
  },
  "1926.501": {
    summary: "Defines construction activities and conditions that require fall protection.",
    topics: ["construction", "fall protection"],
    priority: "critical"
  },
  "1926.651": {
    summary: "Covers excavation requirements including underground installations, access, exposure, and inspections.",
    topics: ["excavation", "trenching", "competent person"],
    priority: "critical"
  },
  "1926.652": {
    summary: "Establishes protective-system requirements for employees working in excavations.",
    topics: ["excavation", "cave-in protection", "trenching"],
    priority: "critical"
  },
  "1926.1153": {
    summary: "Establishes construction controls for respirable crystalline silica exposure.",
    topics: ["silica", "construction", "exposure control"],
    priority: "critical"
  }
};

const requirements = [
  {
    id: "req-1904-29",
    standardIdentifier: "1904.29",
    citation: "29 CFR 1904.29",
    heading: "OSHA forms",
    summary: "Maintain required injury and illness recordkeeping forms when the establishment is covered.",
    relationshipHint: "recordkeeping"
  },
  {
    id: "req-1904-39",
    standardIdentifier: "1904.39",
    citation: "29 CFR 1904.39",
    heading: "Severe-event reporting",
    summary: "Escalate potentially reportable events immediately so the applicable reporting deadline can be assessed.",
    relationshipHint: "reporting"
  },
  {
    id: "req-1910-22-a-1",
    standardIdentifier: "1910.22",
    citation: "29 CFR 1910.22(a)(1)",
    heading: "Surface condition",
    summary: "Keep work areas, passageways, and walking-working surfaces clean, orderly, and sanitary.",
    relationshipHint: "inspection"
  },
  {
    id: "req-1910-38",
    standardIdentifier: "1910.38",
    citation: "29 CFR 1910.38",
    heading: "Emergency action plan",
    summary: "Maintain the required emergency action plan elements and make the plan available to covered workers.",
    relationshipHint: "written_program"
  },
  {
    id: "req-1910-132-d",
    standardIdentifier: "1910.132",
    citation: "29 CFR 1910.132(d)",
    heading: "PPE hazard assessment",
    summary: "Assess workplace hazards to determine whether personal protective equipment is necessary.",
    relationshipHint: "hazard_assessment"
  },
  {
    id: "req-1910-134-c",
    standardIdentifier: "1910.134",
    citation: "29 CFR 1910.134(c)",
    heading: "Respiratory protection program",
    summary: "Establish and administer a written, worksite-specific program when respiratory protection is required.",
    relationshipHint: "written_program"
  },
  {
    id: "req-1910-147-c-7",
    standardIdentifier: "1910.147",
    citation: "29 CFR 1910.147(c)(7)",
    heading: "Energy-control training",
    summary: "Provide training so employees understand the energy-control program and their assigned responsibilities.",
    relationshipHint: "training"
  },
  {
    id: "req-1910-151-c",
    standardIdentifier: "1910.151",
    citation: "29 CFR 1910.151(c)",
    heading: "Emergency flushing",
    summary: "Provide suitable quick drenching or flushing facilities where corrosive exposure to the eyes or body is possible.",
    relationshipHint: "inspection"
  },
  {
    id: "req-1910-178-l",
    standardIdentifier: "1910.178",
    citation: "29 CFR 1910.178(l)",
    heading: "Powered industrial truck training",
    summary: "Train and evaluate powered-industrial-truck operators before authorization and at required intervals or events.",
    relationshipHint: "training"
  },
  {
    id: "req-1910-178-q-7",
    standardIdentifier: "1910.178",
    citation: "29 CFR 1910.178(q)(7)",
    heading: "Unsafe truck removal",
    summary: "Remove an unsafe powered industrial truck from service until it is restored to safe operating condition.",
    relationshipHint: "inspection"
  },
  {
    id: "req-1910-212-a-1",
    standardIdentifier: "1910.212",
    citation: "29 CFR 1910.212(a)(1)",
    heading: "Machine guarding",
    summary: "Use guarding methods that protect operators and other employees from machine hazards.",
    relationshipHint: "inspection"
  },
  {
    id: "req-1910-1200-h",
    standardIdentifier: "1910.1200",
    citation: "29 CFR 1910.1200(h)",
    heading: "Hazard communication training",
    summary: "Provide effective chemical hazard information and training at initial assignment and when new hazards are introduced.",
    relationshipHint: "training"
  },
  {
    id: "req-1926-20-b-2",
    standardIdentifier: "1926.20",
    citation: "29 CFR 1926.20(b)(2)",
    heading: "Construction inspections",
    summary: "Use competent persons to conduct frequent and regular inspections of jobsites, materials, and equipment.",
    relationshipHint: "inspection"
  },
  {
    id: "req-1926-21-b-2",
    standardIdentifier: "1926.21",
    citation: "29 CFR 1926.21(b)(2)",
    heading: "Construction instruction",
    summary: "Instruct employees in recognizing and avoiding unsafe conditions and the regulations applicable to their work.",
    relationshipHint: "training"
  }
];

const statePlans = [
  {
    id: "us-fed-osha",
    name: "Federal OSHA",
    authority: "U.S. Department of Labor — OSHA",
    jurisdiction: "US-FED",
    coverage: "Federal jurisdiction and federal baseline reference",
    officialUrl: "https://www.osha.gov/laws-regs/regulations/standardnumber/",
    locationIds: [],
    note: "Federal OSHA remains the baseline reference and covers retained federal jurisdictions or issues outside a state plan."
  },
  {
    id: "us-or-osha",
    name: "Oregon OSHA",
    authority: "Oregon Occupational Safety and Health",
    jurisdiction: "US-OR",
    coverage: "Private and public-sector state plan",
    officialUrl: "https://osha.oregon.gov/rules/Pages/default.aspx",
    citationFamily: "OAR Chapter 437",
    locationIds: [],
    note: "Oregon rules can adopt, modify, or supplement federal requirements."
  },
  {
    id: "us-wa-dosh",
    name: "Washington DOSH",
    authority: "Washington State Department of Labor & Industries",
    jurisdiction: "US-WA",
    coverage: "Private and public-sector state plan",
    officialUrl: "https://www.lni.wa.gov/safety-health/safety-rules/rules-by-chapter/",
    legalCodeUrl: "https://app.leg.wa.gov/WAC/default.aspx?cite=296",
    citationFamily: "Title 296 WAC",
    locationIds: [],
    note: "The official Washington Administrative Code controls when convenience PDFs differ."
  },
  {
    id: "us-ca-osha",
    name: "Cal/OSHA",
    authority: "California Division of Occupational Safety and Health",
    jurisdiction: "US-CA",
    coverage: "Private and public-sector state plan",
    officialUrl: "https://www.dir.ca.gov/samples/search/query.htm",
    citationFamily: "Title 8 CCR",
    locationIds: [],
    note: "California Title 8 requirements can differ from or supplement the federal baseline."
  }
];

// Company controls and evidence links are tenant data. They load from
// authenticated Supabase rows and are never generated into this public file.
const regulatoryLinks = [];

async function fetchOfficial(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8",
      "User-Agent": "SafetyOps regulatory reference prototype (contact: local-development)"
    },
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`Official source returned ${response.status}: ${url}`);
  }
  return {
    content: await response.text(),
    contentType: response.headers.get("content-type") || "",
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified")
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
}

function scopeForPart(part) {
  if (part === "1904") return "Recordkeeping";
  if (part === "1910") return "General industry";
  if (["1915", "1917", "1918", "1919"].includes(part)) return "Maritime";
  if (part === "1926") return "Construction";
  if (part === "1928") return "Agriculture";
  if (part === "1960") return "Federal workforce";
  if (["1902", "1952", "1953", "1954", "1955", "1956"].includes(part)) return "State plans";
  if (part.startsWith("197")) return "Whistleblower / coverage";
  return "OSHA administration";
}

function walkChapter(node, context, parts, standards) {
  const next = { ...context };
  if (node.type === "part") {
    next.part = node.identifier;
    next.partTitle = node.label_description;
    parts.push({
      id: node.identifier,
      title: node.label_description,
      citation: `29 CFR Part ${node.identifier}`,
      scope: scopeForPart(node.identifier),
      size: node.size || null,
      reserved: Boolean(node.reserved),
      officialUrl: `https://www.ecfr.gov/current/title-29/part-${encodeURIComponent(node.identifier)}`
    });
  }
  if (node.type === "subpart") {
    next.subpart = node.identifier;
    next.subpartTitle = node.label_description;
  }
  if (["section", "appendix"].includes(node.type) && next.part) {
    const isSection = node.type === "section";
    const featured = featuredDefinitions[node.identifier] || null;
    standards.push({
      id: `ecfr-29-${String(node.identifier).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      identifier: node.identifier,
      citation: isSection ? `29 CFR ${node.identifier}` : node.label_level,
      title: node.label_description,
      part: next.part,
      partTitle: next.partTitle,
      subpart: next.subpart || null,
      subpartTitle: next.subpartTitle || null,
      scope: scopeForPart(next.part),
      bindingLevel: "regulation",
      authority: "Federal OSHA / eCFR",
      jurisdiction: "US-FED",
      status: node.reserved ? "reserved" : "current",
      sourceType: node.type,
      receivedOn: node.received_on || null,
      sourceSize: node.size || null,
      officialUrl: isSection
        ? `https://www.ecfr.gov/current/title-29/section-${encodeURIComponent(node.identifier)}`
        : `https://www.ecfr.gov/current/title-29/part-${encodeURIComponent(next.part)}`,
      featured: Boolean(featured),
      summary: featured?.summary || null,
      topics: featured?.topics || [],
      priority: featured?.priority || null
    });
  }
  for (const child of node.children || []) {
    walkChapter(child, next, parts, standards);
  }
}

const titlesUrl = `${apiRoot}/versioner/v1/titles.json`;
const titlesResponse = await fetchOfficial(titlesUrl);
const titlesPayload = JSON.parse(titlesResponse.content);
if (titlesPayload.meta?.import_in_progress) {
  throw new Error("eCFR import is in progress; refusing to publish a partial regulatory snapshot.");
}

const title29 = titlesPayload.titles.find((title) => Number(title.number) === 29);
if (!title29?.up_to_date_as_of) {
  throw new Error("Title 29 freshness metadata was not available.");
}

const currentThrough = title29.up_to_date_as_of;
const structureUrl = `${apiRoot}/versioner/v1/structure/${currentThrough}/title-29.json`;
const structureResponse = await fetchOfficial(structureUrl);
const structure = JSON.parse(structureResponse.content);
const chapter = findNode(
  structure,
  (node) => node.type === "chapter" && String(node.identifier).toUpperCase() === "XVII"
);
if (!chapter) {
  throw new Error("Could not locate Title 29, Chapter XVII in the official structure.");
}

const parts = [];
const standards = [];
walkChapter(chapter, {}, parts, standards);

const fetchedAt = new Date().toISOString();
const partSnapshots = [];
for (const part of corePartIds) {
  const requestUrl = `${apiRoot}/versioner/v1/full/${currentThrough}/title-29.xml?part=${part}`;
  const response = await fetchOfficial(requestUrl);
  partSnapshots.push({
    part,
    requestUrl,
    retrievedAt: fetchedAt,
    currentThrough,
    sha256: sha256(response.content),
    byteLength: Buffer.byteLength(response.content),
    contentType: response.contentType,
    etag: response.etag,
    lastModified: response.lastModified
  });
}

const snapshotByPart = Object.fromEntries(partSnapshots.map((snapshot) => [snapshot.part, snapshot]));
standards.forEach((standard) => {
  standard.sourceSha256 = snapshotByPart[standard.part]?.sha256 || sha256(structureResponse.content);
  standard.currentThrough = currentThrough;
});
requirements.forEach((requirement) => {
  const part = requirement.standardIdentifier.split(".")[0];
  requirement.officialUrl = `https://www.ecfr.gov/current/title-29/section-${requirement.standardIdentifier}#p-${requirement.standardIdentifier}${requirement.citation.replace(`29 CFR ${requirement.standardIdentifier}`, "")}`;
  requirement.currentThrough = currentThrough;
  requirement.sourceSha256 = snapshotByPart[part]?.sha256 || sha256(structureResponse.content);
});

standards.unshift({
  id: "osh-act-section-5-a-1",
  identifier: "osh-act-5-a-1",
  citation: "OSH Act § 5(a)(1) / 29 U.S.C. § 654(a)(1)",
  title: "General Duty Clause",
  part: "OSH-ACT",
  partTitle: "Occupational Safety and Health Act",
  subpart: null,
  subpartTitle: null,
  scope: "All covered employment",
  bindingLevel: "statute",
  authority: "United States Code / OSHA",
  jurisdiction: "US-FED",
  status: "current",
  sourceType: "statute",
  receivedOn: null,
  sourceSize: null,
  officialUrl: "https://www.osha.gov/laws-regs/oshact/section5-duties",
  featured: true,
  summary: "Requires covered employers to address recognized serious hazards even when no specific OSHA standard applies.",
  topics: ["recognized hazards", "general duty", "heat"],
  priority: "critical",
  sourceSha256: null,
  currentThrough: "OSHA page retrieved 2026-07-30"
});

const dataset = {
  meta: {
    generatedAt: fetchedAt,
    title: 29,
    chapter: "XVII",
    authority: "Occupational Safety and Health Administration, Department of Labor",
    currentThrough,
    latestAmendedOn: title29.latest_amended_on,
    latestIssueDate: title29.latest_issue_date,
    importInProgress: false,
    structureUrl,
    structureSha256: sha256(structureResponse.content),
    sourceNotice: "eCFR is continuously updated but is not the official legal edition of the CFR.",
      fullTextNotice: "SafetyOps indexes official metadata and links. Raw XML snapshots belong in private Supabase Storage.",
    generatedBy: "scripts/sync-osha-reference.mjs"
  },
  parts,
  standards,
  requirements,
  regulatoryLinks,
  statePlans,
  partSnapshots
};

await mkdir(path.dirname(manifestFile), { recursive: true });
await writeFile(
  outputFile,
  `// Generated from official eCFR APIs. Do not hand-edit.\nwindow.SafetyOpsRegulatoryData = ${JSON.stringify(dataset)};\n`,
  "utf8"
);
await writeFile(manifestFile, `${JSON.stringify(dataset.meta, null, 2)}\n`, "utf8");

console.log(
  `Indexed ${standards.length.toLocaleString()} OSHA chapter sections/appendices across ${parts.length} parts; current through ${currentThrough}.`
);
