export function submissionFileContentType(file: File): string {
  return file.type.startsWith("image/") || file.type === "application/pdf" ? file.type :
    file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : file.type || "application/octet-stream";
}
