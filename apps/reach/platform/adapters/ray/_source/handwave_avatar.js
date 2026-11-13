// Original illustration served from the authenticated Ray origin, never a CDN.
function makeHandWaveAssistantAvatar(className) {
  const avatar = el('span', className + ' hw-assistant-avatar');
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', '机械姬助手');
  const fallback = el('span', 'hw-avatar-fallback', 'hw');
  fallback.setAttribute('aria-hidden', 'true');
  avatar.appendChild(fallback);
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.width = 32;
  image.height = 32;
  image.addEventListener('load', () => { fallback.hidden = true; }, {once: true});
  image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, {once: true});
  image.src = '@AVATAR_PATH@';
  avatar.appendChild(image);
  return avatar;
}

// This script runs at the end of HandWave's document. Keep its existing name,
// layout and authorization; use the same local image for the brand and tab icon.
function syncHandWaveBrand() {
  const mark = document.querySelector('.brand .mark');
  if (mark && !mark.classList.contains('hw-brand-mark') && mark.textContent.trim() === 'hw') {
    const brand = makeHandWaveAssistantAvatar('mark hw-brand-mark');
    brand.removeAttribute('role');
    brand.removeAttribute('aria-label');
    brand.setAttribute('aria-hidden', 'true');
    mark.replaceWith(brand);
  }
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    favicon.setAttribute('href', '@AVATAR_PATH@');
    favicon.setAttribute('type', 'image/png');
    favicon.removeAttribute('sizes');
  }
}
syncHandWaveBrand();
