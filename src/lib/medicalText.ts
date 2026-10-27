/** Shared plain-text presentation for H5 and native doctor conversations. */
export function formatMedicalText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .trim();
}
