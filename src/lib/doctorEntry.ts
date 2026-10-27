export type DoctorTab = "home" | "ask" | "manage" | "services" | "me";

export function doctorTabPath(slug: string, tab: DoctorTab): string {
  return `/d/${slug}${tab === "ask" ? "/ask" : ""}`;
}

export function resolveDoctorEntryTab(pathname: string, slug: string, readSavedTab: () => string | null): DoctorTab {
  // A shared question-page link takes precedence over this visitor's previous tab.
  // Only the public page path is used; links cannot populate or send a question.
  if (pathname.replace(/\/$/, "") === doctorTabPath(slug, "ask")) return "ask";
  try {
    const saved = readSavedTab();
    if (saved === "home" || saved === "ask" || saved === "manage" || saved === "services" || saved === "me") return saved;
  } catch { /* Storage may be disabled in the embedded browser. */ }
  return "home";
}
