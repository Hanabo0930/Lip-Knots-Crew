/** A navigation hint only. It never selects jobs or submits an operation. */
export function isRecruitmentMailEntry(href: string): boolean {
  try {
    const url = new URL(href);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      ["/", "/index.html"].includes(url.pathname) && url.searchParams.getAll("entry").length === 1 &&
      url.searchParams.get("entry") === "recruitment-mail";
  } catch { return false; }
}
