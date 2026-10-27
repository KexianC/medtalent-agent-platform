export function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;
}

export const COVER_DIABETES = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs>
    <radialGradient id="a" cx="50%" cy="50%">
      <stop offset="0%" stop-color="#8B5E3C" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#FAF7F2"/>
    </radialGradient>
  </defs>
  <rect fill="url(#a)" width="400" height="300" rx="12"/>
  <circle cx="200" cy="135" r="50" fill="none" stroke="#8B5E3C" stroke-width="1.5" opacity="0.18"/>
  <circle cx="200" cy="135" r="30" fill="none" stroke="#8B5E3C" stroke-width="1" opacity="0.12" stroke-dasharray="4 4"/>
  <circle cx="200" cy="135" r="12" fill="#C57B57" opacity="0.12"/>
</svg>
`);

export const COVER_GOUT = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs>
    <radialGradient id="b" cx="30%" cy="30%">
      <stop offset="0%" stop-color="#C57B57" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#FAF7F2"/>
    </radialGradient>
  </defs>
  <rect fill="url(#b)" width="400" height="300" rx="12"/>
  <line x1="100" y1="200" x2="300" y2="200" stroke="#8B5E3C" stroke-width="1.5" opacity="0.12"/>
  <line x1="100" y1="235" x2="300" y2="235" stroke="#8B5E3C" stroke-width="1" opacity="0.08"/>
  <rect x="130" y="155" width="22" height="45" rx="4" fill="#8B5E3C" opacity="0.07"/>
  <rect x="185" y="165" width="18" height="35" rx="4" fill="#8B5E3C" opacity="0.1"/>
  <rect x="230" y="148" width="26" height="52" rx="4" fill="#8B5E3C" opacity="0.08"/>
</svg>
`);

export const COVER_WEIGHT = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs>
    <radialGradient id="c" cx="70%" cy="30%">
      <stop offset="0%" stop-color="#5D7A4A" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#FAF7F2"/>
    </radialGradient>
  </defs>
  <rect fill="url(#c)" width="400" height="300" rx="12"/>
  <ellipse cx="240" cy="160" rx="65" ry="32" fill="#5D7A4A" opacity="0.06" transform="rotate(-15 240 160)"/>
  <ellipse cx="230" cy="155" rx="42" ry="20" fill="#5D7A4A" opacity="0.1" transform="rotate(-15 230 155)"/>
  <line x1="230" y1="110" x2="230" y2="185" stroke="#5D7A4A" stroke-width="1.5" opacity="0.1"/>
</svg>
`);

export const COVER_THYROID = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <defs>
    <radialGradient id="d" cx="50%" cy="50%">
      <stop offset="0%" stop-color="#6B8E6B" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#E8E0D5"/>
    </radialGradient>
  </defs>
  <rect fill="url(#d)" width="640" height="360"/>
  <circle cx="320" cy="180" r="90" fill="none" stroke="#5D7A4A" stroke-width="1.5" opacity="0.12"/>
  <circle cx="320" cy="180" r="60" fill="none" stroke="#5D7A4A" stroke-width="0.8" opacity="0.08" stroke-dasharray="6 4"/>
  <circle cx="320" cy="180" r="20" fill="#5D7A4A" opacity="0.08"/>
</svg>
`);

export const COVER_PCOS = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <defs>
    <radialGradient id="e" cx="30%" cy="40%">
      <stop offset="0%" stop-color="#8B5E3C" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#FAF7F2"/>
    </radialGradient>
  </defs>
  <rect fill="url(#e)" width="640" height="360"/>
  <circle cx="220" cy="180" r="55" fill="none" stroke="#8B5E3C" stroke-width="1.5" opacity="0.1"/>
  <circle cx="220" cy="180" r="25" fill="#8B5E3C" opacity="0.05"/>
  <line x1="280" y1="120" x2="420" y2="120" stroke="#8B5E3C" stroke-width="1" opacity="0.08"/>
  <line x1="280" y1="160" x2="390" y2="160" stroke="#8B5E3C" stroke-width="1" opacity="0.06"/>
  <line x1="280" y1="200" x2="430" y2="200" stroke="#8B5E3C" stroke-width="1" opacity="0.08"/>
</svg>
`);

export const AVATAR_WEIGHT = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <circle cx="64" cy="64" r="64" fill="#5D7A4A" opacity="0.1"/>
  <circle cx="64" cy="88" r="28" fill="#5D7A4A" opacity="0.07"/>
  <circle cx="64" cy="52" r="18" fill="#5D7A4A" opacity="0.09"/>
</svg>
`);

export const AVATAR_DIABETES = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <circle cx="64" cy="64" r="64" fill="#8B5E3C" opacity="0.1"/>
  <circle cx="64" cy="88" r="28" fill="#8B5E3C" opacity="0.07"/>
  <circle cx="64" cy="52" r="18" fill="#8B5E3C" opacity="0.09"/>
</svg>
`);

export const AVATAR_GOUT = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <circle cx="64" cy="64" r="64" fill="#C57B57" opacity="0.1"/>
  <circle cx="64" cy="88" r="28" fill="#C57B57" opacity="0.07"/>
  <circle cx="64" cy="52" r="18" fill="#C57B57" opacity="0.09"/>
</svg>
`);

export const DOCTOR_AVATAR = "/src/assets/doctor-avatar.png";
