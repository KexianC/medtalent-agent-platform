const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// Recognise the recorder's filename; read the date as written in the filename, without applying the device timezone.
function transcriptDate(title) {
  const match = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4}) (\d{2})_(\d{2})_(\d{2}) GMT[+-]\d{4}_原文\.docx$/u.exec(title);
  if (!match) return null;
  const [, monthName, day, year, hours, minutes, seconds] = match;
  const month = MONTHS[monthName];
  const date = new Date(Date.UTC(Number(year), month - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== Number(day)
    || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  return `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Recording transcripts are kept in the knowledge base but are not listed by filename. */
export const TANG_TRANSCRIPT_NOTE = '内容参考唐劲松医生讲解整理';

/** Pure display-only split; formal documents keep their order, titles and URLs. */
export function tangReferenceView(citations) {
  const formal = [];
  let fromTranscripts = false;
  for (const citation of citations) {
    if (transcriptDate(citation.title)) fromTranscripts = true;
    else formal.push({ citation, name: citation.title.replace(/\.[^.]+$/u, '') });
  }
  return { fromTranscripts, formal };
}
