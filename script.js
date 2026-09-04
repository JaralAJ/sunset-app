const LOCATIONS = {
  miami: { label: "Miami, FL", lat: 25.7617, lon: -80.1918 },
  cleveland: { label: "Cleveland, OH", lat: 41.4993, lon: -81.6944 },
};

const els = {
  buttons: document.querySelectorAll(".loc-btn"),
  geoBtn: document.getElementById("geo-btn"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  scoreNum: document.getElementById("score-num"),
  scoreLabel: document.getElementById("score-label"),
  reason: document.getElementById("reason"),
  sunsetTime: document.getElementById("sunset-time"),
  breakdown: document.getElementById("breakdown"),
  outlook: document.getElementById("outlook"),
  placeName: document.getElementById("place-name"),
  switchTrack: document.getElementById("switch-track"),
  switchThumb: document.getElementById("switch-thumb"),
};

// Tracks the currently loaded location's sunrise/sunset (as absolute
// timestamps) so the background can be re-checked against the real clock
// every minute without re-fetching.
let currentSunTimes = null;

init();

function init() {
  setInterval(updateDayPhase, 60 * 1000);
  els.buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveButton(btn);
      const key = btn.dataset.loc;
      loadLocation(LOCATIONS[key].lat, LOCATIONS[key].lon, LOCATIONS[key].label);
    });
  });

  els.geoBtn.addEventListener("click", () => {
    setActiveButton(els.geoBtn);
    if (!navigator.geolocation) {
      showStatus("Geolocation isn't available in this browser.");
      return;
    }
    showStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        loadLocation(pos.coords.latitude, pos.coords.longitude, "Your location");
      },
      (err) => showStatus(geolocationErrorMessage(err)),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  });

  // Default to the last-used location, or Miami.
  const saved = localStorage.getItem("sunset-loc");
  if (saved && LOCATIONS[saved]) {
    setActiveButton(document.querySelector(`[data-loc="${saved}"]`));
    loadLocation(LOCATIONS[saved].lat, LOCATIONS[saved].lon, LOCATIONS[saved].label);
  } else {
    setActiveButton(document.querySelector('[data-loc="miami"]'));
    loadLocation(LOCATIONS.miami.lat, LOCATIONS.miami.lon, LOCATIONS.miami.label);
  }
}

function setActiveButton(btn) {
  els.buttons.forEach((b) => b.classList.remove("active"));
  els.geoBtn.classList.remove("active");
  if (btn) btn.classList.add("active");
  if (btn && btn.dataset.loc) localStorage.setItem("sunset-loc", btn.dataset.loc);
}

async function loadLocation(lat, lon, label) {
  els.placeName.textContent = label;
  els.result.hidden = true;
  showStatus("Checking the sky…");

  try {
    const data = await fetchForecast(lat, lon);
    renderToday(data);
    renderOutlook(data);
    setSunTimesFromForecast(data);
    els.result.hidden = false;
    showStatus("");
  } catch (err) {
    console.error(err);
    showStatus("Couldn't load weather data. Try again in a moment.");
  }
}

function showStatus(msg) {
  els.status.textContent = msg;
}

function geolocationErrorMessage(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location access is blocked. Allow it for this site in your browser settings, and make sure location is turned on for your device.";
    case err.POSITION_UNAVAILABLE:
      return "Your device couldn't determine a location right now. Try again or use a saved city.";
    case err.TIMEOUT:
      return "Finding your location took too long. Try again or use a saved city.";
    default:
      return "Couldn't get your location. Try a saved city instead.";
  }
}

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility",
    daily: "sunrise,sunset",
    forecast_days: "6",
    timezone: "auto",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json();
}

// Open-Meteo's "auto timezone" times are plain wall-clock strings with no
// offset (e.g. "2026-09-04T19:32") — they're local to the requested
// location, not UTC. To compare them against the real current instant
// (Date.now()) regardless of what timezone the browser itself is in, we
// use the response's utc_offset_seconds to convert to a true UTC ms value.
function toAbsoluteMs(localIso, utcOffsetSeconds) {
  return Date.parse(`${localIso}Z`) - utcOffsetSeconds * 1000;
}

function setSunTimesFromForecast(data) {
  const offset = data.utc_offset_seconds || 0;
  currentSunTimes = {
    sunrise: toAbsoluteMs(data.daily.sunrise[0], offset),
    sunset: toAbsoluteMs(data.daily.sunset[0], offset),
  };
  updateDayPhase();
}

// Golden-hour-ish window around actual sunrise/sunset; outside daylight
// hours entirely it's night, otherwise midday.
const DAY_PHASE_WINDOW_MS = 50 * 60 * 1000;

function getDayPhase(nowMs, sunriseMs, sunsetMs) {
  if (Math.abs(nowMs - sunriseMs) <= DAY_PHASE_WINDOW_MS) return "sunrise";
  if (Math.abs(nowMs - sunsetMs) <= DAY_PHASE_WINDOW_MS) return "sunset";
  if (nowMs > sunriseMs && nowMs < sunsetMs) return "midday";
  return "night";
}

function updateDayPhase() {
  if (!currentSunTimes) return;
  document.body.dataset.phase = getDayPhase(Date.now(), currentSunTimes.sunrise, currentSunTimes.sunset);
}

// Sunset color peaks in the ~20 min after the sun dips below the horizon
// (civil twilight), so we score the hour containing sunset itself.
function hourIndexForTime(hourlyTimes, targetIso) {
  const target = new Date(targetIso).getTime();
  let bestIdx = 0;
  let bestDiff = Infinity;
  hourlyTimes.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

// Scoring heuristic:
// - Low clouds near the horizon block the sun before it can light anything
//   up, so they're penalized — but Open-Meteo only gives sky-wide cloud
//   cover, not which direction it's in, so a moderate amount doesn't
//   necessarily mean the western horizon itself is blocked. We penalize
//   low cloud less steeply than the old version did, and never zero it out.
// - Mid/high cloud is what actually catches and scatters color. Real
//   vivid sunsets often have HEAVY (60-90%) mid/high cloud (thin cirrus
//   lights up across the whole sky) — only a fully bare or fully solid
//   overcast sky is truly dull, so the sweet spot is wide, not a narrow
//   peak, and the high side tapers off gently rather than collapsing.
// - Lower humidity / higher visibility means crisper, more saturated color.
function scoreSunset({ low, mid, high, humidity, visibility }) {
  const lowScore = clamp(100 - low, 10, 100);

  const midHigh = Math.max(mid, high * 0.9);
  const midHighScore = midHighCloudScore(midHigh);

  const humidityScore = clamp(100 - humidity, 0, 100);
  const visKm = visibility / 1000;
  const visibilityScore = clamp((visKm / 20) * 100, 0, 100);
  const clarityScore = humidityScore * 0.6 + visibilityScore * 0.4;

  const overall = Math.round(lowScore * 0.4 + midHighScore * 0.45 + clarityScore * 0.15);

  return { overall: clamp(overall, 0, 100), lowScore, midHighScore, clarityScore, midHigh };
}

// Wide "sweet spot" plateau from 35-75% cover, gentle ramps on both sides,
// and a floor well above zero even at the extremes (bare sky is plain but
// not ugly; heavy cloud is often still colorful, just less dramatic).
function midHighCloudScore(midHigh) {
  if (midHigh <= 10) return 40 + (midHigh / 10) * 10;
  if (midHigh <= 35) return 50 + ((midHigh - 10) / 25) * 45;
  if (midHigh <= 75) return 95 + ((midHigh - 35) / 40) * 5;
  return clamp(100 - ((midHigh - 75) / 25) * 35, 65, 100);
}

function labelFor(score) {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Meh";
  if (score >= 20) return "Poor";
  return "Skip it";
}

function reasonFor({ low, humidity }, s) {
  const parts = [];
  if (low > 70) parts.push("thick low clouds will likely block the sun");
  else if (low > 35) parts.push("some low cloud could dim the show");
  else parts.push("clear near the horizon");

  if (s.midHigh >= 25 && s.midHigh <= 85) parts.push("nice mid/high clouds to catch color");
  else if (s.midHigh < 25) parts.push("sky is pretty bare, so color may be mild");
  else parts.push("heavy cloud cover up high could still light up, but may look more muted");

  if (humidity < 50) parts.push("dry air for crisp color");
  else if (humidity > 80) parts.push("humid/hazy air may wash out color");

  return capitalize(parts.join("; ") + ".");
}

function renderToday(data) {
  const { hourly, daily } = data;
  const sunsetIso = daily.sunset[0];
  const idx = hourIndexForTime(hourly.time, sunsetIso);

  const conditions = {
    low: hourly.cloud_cover_low[idx],
    mid: hourly.cloud_cover_mid[idx],
    high: hourly.cloud_cover_high[idx],
    humidity: hourly.relative_humidity_2m[idx],
    visibility: hourly.visibility[idx],
  };

  const s = scoreSunset(conditions);

  const level = levelClass(s.overall);

  els.scoreNum.textContent = s.overall;
  els.scoreLabel.textContent = labelFor(s.overall);
  els.scoreLabel.dataset.level = level;
  els.reason.textContent = reasonFor(conditions, s);
  positionSwitchThumb(s.overall, level);
  els.sunsetTime.textContent = new Date(sunsetIso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  els.breakdown.innerHTML = "";
  addBreakdownRow("Low clouds", `${conditions.low}%`);
  addBreakdownRow("Mid clouds", `${conditions.mid}%`);
  addBreakdownRow("High clouds", `${conditions.high}%`);
  addBreakdownRow("Humidity", `${conditions.humidity}%`);
  addBreakdownRow("Visibility", `${(conditions.visibility / 1000).toFixed(1)} km`);
}

// Moves the sun thumb across the switch track and scales its size/glow
// with the score, so a bad sunset reads as a small dim sun on the left
// and a great one reads as a big glowing sun on the right.
function positionSwitchThumb(score, level) {
  els.switchTrack.dataset.level = level;

  const trackWidth = els.switchTrack.clientWidth || 340;
  const minSize = 56;
  const maxSize = 88;
  const size = minSize + ((maxSize - minSize) * score) / 100;
  const pad = 8;
  const travel = trackWidth - size - pad * 2;
  const left = pad + (travel * score) / 100;
  const top = (96 - size) / 2;

  els.switchThumb.style.width = `${size}px`;
  els.switchThumb.style.height = `${size}px`;
  els.switchThumb.style.left = `${left}px`;
  els.switchThumb.style.top = `${top}px`;

  const glowStrength = 6 + (score / 100) * 26;
  const glowOpacity = 0.15 + (score / 100) * 0.45;
  els.switchThumb.style.boxShadow =
    `inset -6px -6px 10px rgba(120, 60, 0, 0.18), 0 0 ${glowStrength}px rgba(255, 154, 60, ${glowOpacity})`;
}

function addBreakdownRow(label, value) {
  const row = document.createElement("div");
  row.className = "breakdown-row";
  row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  els.breakdown.appendChild(row);
}

function renderOutlook(data) {
  const { hourly, daily } = data;
  els.outlook.innerHTML = "";

  daily.sunset.slice(1).forEach((sunsetIso) => {
    const idx = hourIndexForTime(hourly.time, sunsetIso);
    const conditions = {
      low: hourly.cloud_cover_low[idx],
      mid: hourly.cloud_cover_mid[idx],
      high: hourly.cloud_cover_high[idx],
      humidity: hourly.relative_humidity_2m[idx],
      visibility: hourly.visibility[idx],
    };
    const s = scoreSunset(conditions);
    const day = new Date(sunsetIso).toLocaleDateString([], { weekday: "short" });

    const level = levelClass(s.overall);
    const card = document.createElement("div");
    card.className = "outlook-card";
    card.innerHTML = `
      <div class="outlook-day">${day}</div>
      <div class="outlook-sun" data-level="${level}"></div>
      <div class="outlook-score" data-level="${level}">${s.overall}</div>
    `;
    els.outlook.appendChild(card);
  });
}

function levelClass(score) {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "meh";
  if (score >= 20) return "poor";
  return "skip";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
