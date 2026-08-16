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

init();

function init() {
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
      () => showStatus("Couldn't get your location. Try a saved city instead.")
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

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility",
    daily: "sunset",
    forecast_days: "6",
    timezone: "auto",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json();
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
//   up, so they're penalized heavily.
// - A moderate amount of mid/high cloud is what actually catches and
//   scatters color; too little is a plain clear sky, too much is overcast.
// - Lower humidity / higher visibility means crisper, more saturated color.
// Open-Meteo doesn't give cloud cover by compass direction, so this uses
// overall sky cover as a stand-in for "clouds toward the western horizon."
function scoreSunset({ low, mid, high, humidity, visibility }) {
  const lowScore = clamp(100 - low * 1.3, 0, 100);

  const midHigh = Math.max(mid, high * 0.9);
  const idealCenter = 40;
  const spread = 35;
  const midHighScore = clamp(100 - (Math.abs(midHigh - idealCenter) / spread) * 100, 5, 100);

  const humidityScore = clamp(100 - humidity, 0, 100);
  const visKm = visibility / 1000;
  const visibilityScore = clamp((visKm / 20) * 100, 0, 100);
  const clarityScore = humidityScore * 0.6 + visibilityScore * 0.4;

  const overall = Math.round(lowScore * 0.45 + midHighScore * 0.4 + clarityScore * 0.15);

  return { overall: clamp(overall, 0, 100), lowScore, midHighScore, clarityScore, midHigh };
}

function labelFor(score) {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Meh";
  if (score >= 20) return "Poor";
  return "Skip it";
}

function reasonFor({ low, mid, high, humidity }, s) {
  const parts = [];
  if (low > 60) parts.push("thick low clouds will likely block the sun");
  else if (low > 30) parts.push("some low cloud could dim the show");
  else parts.push("clear near the horizon");

  if (s.midHigh >= 25 && s.midHigh <= 60) parts.push("nice mid/high clouds to catch color");
  else if (s.midHigh < 25) parts.push("sky is pretty bare, so color may be mild");
  else parts.push("heavy cloud cover up high could mute the color");

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
