// Pick a doctor's own videos for a question; only keyword hits, never a guess.
export function matchDoctorVideos(question, videos = [], limit = 2) {
  const text = String(question || '').toLowerCase();
  if (!text.trim()) return [];
  return videos.filter(video => video.url && video.keywords.some(word => word && text.includes(word.toLowerCase()))).slice(0, limit);
}
