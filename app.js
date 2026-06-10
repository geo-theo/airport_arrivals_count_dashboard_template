"use strict";

const PERIODS = {
  live: { hours: 1, trendHours: 12, label: "latest completed hour", short: "LATEST" },
  "24h": { hours: 24, trendHours: 24, label: "previous 24h", short: "24H" },
  "7d": { hours: 24 * 7, trendHours: 24 * 7, label: "previous 7d", short: "7D" },
  "30d": { hours: 24 * 30, trendHours: 24 * 30, label: "previous 30d", short: "30D" },
  "1y": { hours: 24 * 365, trendHours: 24 * 365, label: "previous year", short: "1Y" },
};

const REGION_COLORS = {
  West: "#2dd4bf",
  Southwest: "#38bdf8",
  Midwest: "#a78bfa",
  Southeast: "#f5b95f",
  Northeast: "#fb7185",
  Noncontiguous: "#94a3b8",
};

const HOUR_FACTORS = [
  0.35, 0.26, 0.23, 0.25, 0.34, 0.52, 0.72, 0.86, 0.96, 1.03, 1.08, 1.12,
  1.16, 1.19, 1.24, 1.31, 1.39, 1.45, 1.39, 1.24, 1.05, 0.85, 0.65, 0.47,
];

const DAY_FACTORS = [0.94, 0.91, 0.95, 1.01, 1.07, 1.1, 0.98];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const state = {
  airports: [],
  observations: { meta: {}, buckets: [] },
  observedByHour: new Map(),
  period: "24h",
  region: "all",
  search: "",
  airportRows: 5,
  charts: {},
  map: null,
  mapLayer: null,
  data: null,
};

const numberFormatter = new Intl.NumberFormat("en-US");
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindControls();
  buildDecorativeElements();

  try {
    const [airportsResponse, arrivalsResponse] = await Promise.all([
      fetch("data/airports.json", { cache: "no-store" }),
      fetch(`data/arrivals.json?ts=${Date.now()}`, { cache: "no-store" }),
    ]);

    if (!airportsResponse.ok) throw new Error("Airport metadata could not be loaded.");
    state.airports = await airportsResponse.json();
    state.observations = arrivalsResponse.ok
      ? await arrivalsResponse.json()
      : { meta: { source: "sample" }, buckets: [] };
    indexObservedData();
    initializeMap();
    updateDashboard();
  } catch (error) {
    console.error(error);
    showToast("The dashboard data files could not be loaded. Start a local web server instead of opening the file directly.");
    setSourceStatus("Data unavailable", false);
  }

  observeSections();
}

function bindControls() {
  document.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-period]").forEach((item) => item.classList.remove("is-selected"));
      button.classList.add("is-selected");
      state.period = button.dataset.period;
      updateDashboard();
    });
  });

  document.getElementById("region-select").addEventListener("change", (event) => {
    state.region = event.target.value;
    updateDashboard();
    focusMapOnSelection();
  });

  let searchTimer;
  document.getElementById("airport-search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = event.target.value.trim().toLowerCase();
      updateDashboard();
      focusMapOnSelection();
    }, 180);
  });

  document.getElementById("show-more-airports").addEventListener("click", () => {
    state.airportRows = state.airportRows === 5 ? 10 : 5;
    document.getElementById("show-more-airports").textContent = state.airportRows === 5 ? "Show 10" : "Show 5";
    renderAirportTable(state.data);
  });

  document.getElementById("refresh-button").addEventListener("click", refreshData);
}

async function refreshData() {
  const button = document.getElementById("refresh-button");
  button.classList.add("is-spinning");
  button.disabled = true;

  try {
    const response = await fetch(`data/arrivals.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Refresh failed");
    state.observations = await response.json();
    indexObservedData();
    updateDashboard();
    showToast(state.observedByHour.size ? "Observed arrival data refreshed." : "Sample baseline refreshed. Connect OpenSky to add observed data.");
  } catch (error) {
    console.error(error);
    showToast("Could not refresh the data file. The current view is unchanged.");
  } finally {
    window.setTimeout(() => {
      button.classList.remove("is-spinning");
      button.disabled = false;
    }, 450);
  }
}

function indexObservedData() {
  state.observedByHour = new Map();
  for (const bucket of state.observations.buckets || []) {
    const hour = floorHour(new Date(bucket.start)).getTime();
    const counts = new Map((bucket.arrivals || []).map((item) => [item.airport, item.count]));
    state.observedByHour.set(hour, {
      counts,
      total: bucket.total || 0,
      unknownCount: bucket.unknownCount || 0,
    });
  }
}

function updateDashboard() {
  if (!state.airports.length) return;
  const data = buildDashboardData();
  state.data = data;
  renderStatus(data);
  renderKpis(data);
  renderMap(data);
  renderRegionChart(data);
  renderTrendChart(data);
  renderHourlyChart(data);
  renderAirportTable(data);
  renderHeatmap(data);
}

function buildDashboardData() {
  const config = PERIODS[state.period];
  const end = floorHour(new Date());
  const selectedAirports = getSelectedAirports();
  const metricStart = new Date(end.getTime() - config.hours * 3600000);
  const previousStart = new Date(metricStart.getTime() - config.hours * 3600000);
  const trendStart = new Date(end.getTime() - config.trendHours * 3600000);
  const rhythmStart = new Date(end.getTime() - Math.max(config.hours, 24 * 14) * 3600000);

  const current = calculateRange(selectedAirports, metricStart, end);
  const previous = calculateRange(selectedAirports, previousStart, metricStart);
  const trend = calculateRange(selectedAirports, trendStart, end);
  const rhythm = calculateRange(selectedAirports, rhythmStart, end);
  const regionTotals = summarizeRegions(current.airportTotals, selectedAirports);
  const airportRows = selectedAirports
    .map((airport) => {
      const count = current.airportTotals.get(airport.icao) || 0;
      const previousCount = previous.airportTotals.get(airport.icao) || 0;
      return {
        ...airport,
        count,
        previousCount,
        change: previousCount ? ((count - previousCount) / previousCount) * 100 : 0,
        share: current.total ? (count / current.total) * 100 : 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  const observedHours = current.records.filter((record) => record.observed).length;
  const change = previous.total ? ((current.total - previous.total) / previous.total) * 100 : 0;
  const hourlyAverage = buildLocalHourProfile(rhythm.records, selectedAirports);
  const peakValue = Math.max(...hourlyAverage);
  const peakHour = Math.max(0, hourlyAverage.indexOf(peakValue));

  return {
    config,
    selectedAirports,
    current,
    previous,
    trend,
    regionTotals,
    airportRows,
    change,
    observedHours,
    hourlyAverage,
    peakHour,
    peakValue,
    activeHubs: airportRows.filter((airport) => airport.count / config.hours >= 20).length,
  };
}

function getSelectedAirports() {
  return state.airports.filter((airport) => {
    const regionMatch = state.region === "all" || airport.region === state.region;
    const haystack = `${airport.iata} ${airport.icao} ${airport.name} ${airport.city} ${airport.state}`.toLowerCase();
    const searchMatch = !state.search || haystack.includes(state.search);
    return regionMatch && searchMatch;
  });
}

function calculateRange(airports, start, end) {
  const airportTotals = new Map(airports.map((airport) => [airport.icao, 0]));
  const records = [];
  let total = 0;

  for (let timestamp = start.getTime(); timestamp < end.getTime(); timestamp += 3600000) {
    const date = new Date(timestamp);
    const observed = state.observedByHour.get(timestamp);
    const counts = new Map();
    let hourTotal = 0;

    for (const airport of airports) {
      const count = observed
        ? observed.counts.get(airport.icao) || 0
        : sampleAirportHour(airport, date);
      counts.set(airport.icao, count);
      airportTotals.set(airport.icao, (airportTotals.get(airport.icao) || 0) + count);
      hourTotal += count;
    }

    records.push({ timestamp, total: hourTotal, counts, observed: Boolean(observed) });
    total += hourTotal;
  }

  return { total, airportTotals, records };
}

function sampleAirportHour(airport, date) {
  const localHour = positiveModulo(date.getUTCHours() + airport.utcOffset, 24);
  const localDate = new Date(date.getTime() + airport.utcOffset * 3600000);
  const dayFactor = DAY_FACTORS[localDate.getUTCDay()];
  const hourFactor = HOUR_FACTORS[localHour];
  const seasonFactor = 0.98 + Math.sin(((localDate.getUTCMonth() + 1.4) / 12) * Math.PI * 2) * 0.07;
  const growthFactor = 1 + (date.getUTCFullYear() - 2025) * 0.018;
  const noise = 0.88 + seededValue(`${airport.icao}-${date.toISOString().slice(0, 13)}`) * 0.25;
  const eventBump = seededValue(`${date.toISOString().slice(0, 10)}-${airport.region}`) > 0.965 ? 1.12 : 1;
  return Math.max(0, Math.round(airport.base * hourFactor * dayFactor * seasonFactor * growthFactor * noise * eventBump));
}

function buildLocalHourProfile(records, airports) {
  const sums = Array(24).fill(0);
  const samples = Array(24).fill(0);
  const airportByIcao = new Map(airports.map((airport) => [airport.icao, airport]));

  for (const record of records) {
    for (const [icao, count] of record.counts) {
      const airport = airportByIcao.get(icao);
      if (!airport) continue;
      const hour = positiveModulo(new Date(record.timestamp).getUTCHours() + airport.utcOffset, 24);
      sums[hour] += count;
      samples[hour] += 1;
    }
  }

  return sums.map((sum, index) => Math.round(sum / Math.max(1, samples[index])));
}

function summarizeRegions(airportTotals, airports) {
  const totals = new Map(Object.keys(REGION_COLORS).map((region) => [region, 0]));
  for (const airport of airports) {
    totals.set(airport.region, (totals.get(airport.region) || 0) + (airportTotals.get(airport.icao) || 0));
  }
  return [...totals.entries()]
    .map(([region, count]) => ({ region, count }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function renderStatus(data) {
  const generatedAt = state.observations.meta?.generatedAt;
  const hasAnyObserved = state.observedByHour.size > 0;
  const hasObservedInView = data.observedHours > 0;
  const sourceLabel = hasObservedInView
    ? `OpenSky + sample (${data.observedHours}h observed)`
    : hasAnyObserved
      ? "Sample history + OpenSky recent"
      : "Sample baseline";

  setSourceStatus(sourceLabel, hasObservedInView);
  document.getElementById("sidebar-source").textContent = hasAnyObserved ? "OpenSky connected" : "Sample baseline";
  document.getElementById("sidebar-updated").textContent = generatedAt
    ? `Updated ${formatRelativeTime(new Date(generatedAt))}`
    : "Ready to connect";
  document.getElementById("footer-timestamp").textContent = generatedAt
    ? `Last observed update ${formatDateTime(new Date(generatedAt))}`
    : `Sample generated ${formatDateTime(new Date())}`;
  document.getElementById("methodology-copy").textContent = hasAnyObserved
    ? "Recent periods use completed-flight observations collected from OpenSky by GitHub Actions. Gaps and longer historical views retain the deterministic sample baseline, so observed and modeled data are never silently conflated."
    : "The starter dataset is a deterministic model for demonstration. Add OpenSky credentials to GitHub Actions to replace recent hourly periods with observed completed-flight records. Airport metadata follows the OurAirports schema.";
}

function setSourceStatus(label, observed) {
  document.getElementById("source-label").textContent = label;
  const status = document.getElementById("data-status");
  status.classList.toggle("is-observed", observed);
}

function renderKpis(data) {
  const topAirport = data.airportRows[0];
  document.getElementById("metric-total").textContent = formatNumber(data.current.total);

  const changeElement = document.getElementById("metric-change");
  const roundedChange = Math.abs(data.change) < 0.05 ? 0 : data.change;
  changeElement.textContent = `${roundedChange >= 0 ? "↑" : "↓"} ${Math.abs(roundedChange).toFixed(1)}%`;
  changeElement.classList.toggle("positive", roundedChange >= 0);
  changeElement.classList.toggle("negative", roundedChange < 0);
  document.getElementById("metric-period-label").textContent = `vs ${data.config.label}`;

  document.getElementById("metric-airport").textContent = topAirport?.iata || "--";
  document.getElementById("metric-airport-name").textContent = topAirport
    ? `${topAirport.city}, ${topAirport.state}`
    : "No matching airport";
  document.getElementById("metric-airport-count").textContent = topAirport
    ? `${formatNumber(topAirport.count)} arrivals`
    : "0 arrivals";
  document.getElementById("metric-airport-bar").style.width = topAirport
    ? `${Math.min(100, topAirport.share * 5.2)}%`
    : "0%";

  document.getElementById("metric-peak").textContent = formatHour(data.peakHour);
  document.getElementById("metric-peak-count").textContent = `${formatNumber(data.peakValue)} avg arrivals per airport`;
  document.getElementById("metric-hubs").textContent = formatNumber(data.activeHubs);
  document.getElementById("metric-coverage").textContent = `Across ${data.selectedAirports.length} selected airports`;
  document.getElementById("map-total").textContent = `${formatNumber(data.current.total)} arrivals`;
  document.getElementById("region-period").textContent = data.config.short;
  document.getElementById("donut-total").textContent = compactFormatter.format(data.current.total);

  renderSparkline(data.trend.records.map((record) => record.total));
  renderPeakBars(data.hourlyAverage, data.peakHour);
  renderHubDots(data.activeHubs, data.selectedAirports.length);
}

function renderSparkline(values) {
  const element = document.getElementById("total-sparkline");
  const sampled = downsample(values, 24);
  const max = Math.max(1, ...sampled);
  const min = Math.min(...sampled);
  const range = Math.max(1, max - min);
  const points = sampled
    .map((value, index) => {
      const x = (index / Math.max(1, sampled.length - 1)) * 100;
      const y = 30 - ((value - min) / range) * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  element.innerHTML = `
    <svg viewBox="0 0 100 34" preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2dd4bf" stop-opacity=".26"/>
          <stop offset="100%" stop-color="#2dd4bf" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="0,34 ${points} 100,34" fill="url(#spark-fill)"></polygon>
      <polyline points="${points}" fill="none" stroke="#2dd4bf" stroke-width="1.3" vector-effect="non-scaling-stroke"></polyline>
    </svg>
  `;
}

function renderPeakBars(values, peakHour) {
  const container = document.getElementById("peak-bars");
  const max = Math.max(1, ...values);
  container.innerHTML = values
    .filter((_, index) => index % 2 === 0)
    .map((value, index) => {
      const representedHour = index * 2;
      const hot = Math.abs(representedHour - peakHour) <= 1 ? "hot" : "";
      return `<span class="${hot}" style="height:${Math.max(4, (value / max) * 24)}px"></span>`;
    })
    .join("");
}

function renderHubDots(active, total) {
  const container = document.getElementById("hub-dots");
  const dots = Math.min(18, Math.max(8, total));
  const activeDots = total ? Math.round((active / total) * dots) : 0;
  container.innerHTML = Array.from(
    { length: dots },
    (_, index) => `<span class="${index < activeDots ? "active" : ""}"></span>`,
  ).join("");
}

function initializeMap() {
  if (!window.L) {
    document.getElementById("map-fallback").hidden = false;
    return;
  }

  state.map = L.map("arrivals-map", {
    zoomControl: true,
    scrollWheelZoom: false,
    minZoom: 3,
    maxZoom: 9,
  }).setView([38.2, -97.2], 4);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(state.map);

  state.mapLayer = L.layerGroup().addTo(state.map);
  window.setTimeout(() => state.map.invalidateSize(), 100);
}

function renderMap(data) {
  if (!state.map || !state.mapLayer) return;
  state.mapLayer.clearLayers();
  const maximum = Math.max(1, ...data.airportRows.map((airport) => airport.count));

  for (const airport of data.airportRows) {
    if (!airport.count) continue;
    const intensity = airport.count / maximum;
    const color = intensity > 0.67 ? "#fb7185" : intensity > 0.28 ? "#2dd4bf" : "#38bdf8";
    const radius = 3.5 + Math.sqrt(intensity) * 11;
    const marker = L.circleMarker([airport.lat, airport.lon], {
      radius,
      color,
      weight: 1.2,
      opacity: 0.82,
      fillColor: color,
      fillOpacity: 0.2 + intensity * 0.42,
    });

    marker.bindPopup(`
      <div class="airport-popup">
        <strong>${escapeHtml(airport.iata)} · ${escapeHtml(airport.city)}</strong>
        <span>${escapeHtml(airport.name)}</span>
        <b>${formatNumber(airport.count)} arrivals</b>
        <span>${airport.share.toFixed(1)}% of selected network</span>
      </div>
    `);
    marker.addTo(state.mapLayer);
  }
}

function focusMapOnSelection() {
  if (!state.map) return;
  const airports = getSelectedAirports();
  if (!airports.length) return;
  if (state.region === "all" && !state.search) {
    state.map.setView([38.2, -97.2], 4);
    return;
  }
  const bounds = L.latLngBounds(airports.map((airport) => [airport.lat, airport.lon]));
  state.map.fitBounds(bounds.pad(0.35), { maxZoom: 6 });
}

function renderRegionChart(data) {
  const labels = data.regionTotals.map((item) => item.region);
  const values = data.regionTotals.map((item) => item.count);
  const colors = labels.map((label) => REGION_COLORS[label]);

  if (window.Chart) {
    if (state.charts.region) {
      state.charts.region.data.labels = labels;
      state.charts.region.data.datasets[0].data = values;
      state.charts.region.data.datasets[0].backgroundColor = colors;
      state.charts.region.update();
    } else {
      state.charts.region = new Chart(document.getElementById("region-chart"), {
        type: "doughnut",
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: colors,
            borderColor: "#0b1b2b",
            borderWidth: 4,
            hoverOffset: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "73%",
          plugins: {
            legend: { display: false },
            tooltip: chartTooltipOptions((context) => `${context.label}: ${formatNumber(context.raw)}`),
          },
        },
      });
    }
  }

  const max = Math.max(1, ...values);
  document.getElementById("region-list").innerHTML = data.regionTotals
    .map((item) => `
      <div class="region-item" style="--region-color:${REGION_COLORS[item.region]};--region-width:${(item.count / max) * 100}%">
        <span class="region-name"><i></i>${item.region}</span>
        <span class="region-track"><span></span></span>
        <span class="region-value">${data.current.total ? ((item.count / data.current.total) * 100).toFixed(0) : 0}%</span>
      </div>
    `)
    .join("");
}

function renderTrendChart(data) {
  if (!window.Chart) return;
  const currentSeries = groupTrendRecords(data.trend.records, state.period);
  const previousSeries = groupTrendRecords(data.previous.records, state.period);
  const previousValues = alignPreviousSeries(previousSeries.values, currentSeries.values.length);
  document.getElementById("trend-title").textContent = trendTitleForPeriod(state.period);

  const chartData = {
    labels: currentSeries.labels,
    datasets: [
      {
        label: "Current period",
        data: currentSeries.values,
        borderColor: "#2dd4bf",
        backgroundColor: createTrendGradient("trend-chart"),
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        tension: 0.34,
        fill: true,
      },
      {
        label: "Previous period",
        data: previousValues,
        borderColor: "rgba(148, 163, 184, .38)",
        backgroundColor: "transparent",
        pointRadius: 0,
        pointHoverRadius: 3,
        borderWidth: 1.4,
        borderDash: [4, 5],
        tension: 0.34,
      },
    ],
  };

  if (state.charts.trend) {
    state.charts.trend.data = chartData;
    state.charts.trend.update();
  } else {
    state.charts.trend = new Chart(document.getElementById("trend-chart"), {
      type: "line",
      data: chartData,
      options: baseCartesianOptions((context) => `${formatNumber(context.raw)} arrivals`),
    });
  }
}

function renderHourlyChart(data) {
  if (!window.Chart) return;
  const labels = Array.from({ length: 24 }, (_, hour) => (hour % 3 === 0 ? formatHour(hour) : ""));
  const dataset = {
    labels,
    datasets: [{
      label: "Average arrivals",
      data: data.hourlyAverage,
      backgroundColor: data.hourlyAverage.map((_, hour) =>
        Math.abs(hour - data.peakHour) <= 1 ? "rgba(245, 185, 95, .92)" : "rgba(56, 189, 248, .28)"),
      borderRadius: 4,
      borderSkipped: false,
      maxBarThickness: 11,
    }],
  };

  const options = baseCartesianOptions((context) => `${formatNumber(context.raw)} average arrivals`);
  options.scales.x.grid.display = false;
  options.scales.y.display = false;
  options.plugins.legend.display = false;

  if (state.charts.hourly) {
    state.charts.hourly.data = dataset;
    state.charts.hourly.options = options;
    state.charts.hourly.update();
  } else {
    state.charts.hourly = new Chart(document.getElementById("hourly-chart"), {
      type: "bar",
      data: dataset,
      options,
    });
  }

  const startPeak = formatHour(Math.max(0, data.peakHour - 1));
  const endPeak = formatHour(Math.min(23, data.peakHour + 1));
  document.getElementById("hourly-insight").textContent =
    `The strongest arrival bank runs from ${startPeak} to ${endPeak} local time.`;
}

function renderAirportTable(data) {
  if (!data) return;
  const rows = data.airportRows.slice(0, state.airportRows);
  const body = document.getElementById("airport-table-body");
  body.innerHTML = rows.length
    ? rows.map((airport) => `
      <tr>
        <td>
          <div class="airport-cell">
            <span class="airport-code">${airport.iata}</span>
            <span>
              <strong>${escapeHtml(airport.name)}</strong>
              <small>${escapeHtml(airport.city)}, ${airport.state}</small>
            </span>
          </div>
        </td>
        <td>${airport.region}</td>
        <td>${formatNumber(airport.count)}</td>
        <td class="share-cell">
          <span class="share-number">${airport.share.toFixed(1)}%</span>
          <span class="share-track"><span style="width:${Math.min(100, airport.share * 5.5)}%"></span></span>
        </td>
        <td><span class="pulse-value ${airport.change >= 0 ? "up" : "down"}">${airport.change >= 0 ? "↑" : "↓"} ${Math.abs(airport.change).toFixed(1)}%</span></td>
      </tr>
    `).join("")
    : `<tr><td colspan="5">No airports match the current filters.</td></tr>`;
}

function renderHeatmap(data) {
  const container = document.getElementById("arrival-heatmap");
  const airports = data.selectedAirports;
  const totalBase = airports.reduce((sum, airport) => sum + airport.base, 0);
  const values = [];
  let maximum = 0;
  let strongest = { day: 0, hour: 0, value: 0 };

  for (let day = 0; day < 7; day += 1) {
    const row = [];
    for (let bin = 0; bin < 12; bin += 1) {
      const hour = bin * 2;
      const value = totalBase * DAY_FACTORS[day] * ((HOUR_FACTORS[hour] + HOUR_FACTORS[hour + 1]) / 2);
      row.push(value);
      maximum = Math.max(maximum, value);
      if (value > strongest.value) strongest = { day, hour, value };
    }
    values.push(row);
  }

  const cells = ['<span class="heat-label"></span>'];
  for (let bin = 0; bin < 12; bin += 1) {
    cells.push(`<span class="heat-label">${bin % 2 === 0 ? formatHour(bin * 2).replace(" ", "") : ""}</span>`);
  }

  for (let day = 1; day <= 7; day += 1) {
    const dayIndex = day % 7;
    cells.push(`<span class="heat-label">${DAY_NAMES[dayIndex].slice(0, 1)}</span>`);
    for (let bin = 0; bin < 12; bin += 1) {
      const normalized = maximum ? values[dayIndex][bin] / maximum : 0;
      const opacity = 0.055 + normalized * 0.76;
      cells.push(
        `<span class="heat-cell" style="--heat:${opacity.toFixed(3)}" title="${DAY_NAMES[dayIndex]} ${formatHour(bin * 2)} · relative intensity ${Math.round(normalized * 100)}%"></span>`,
      );
    }
  }

  container.innerHTML = cells.join("");
  document.getElementById("heatmap-highlight").textContent =
    `${DAY_NAMES[strongest.day]} ${formatHour(strongest.hour)}`;
}

function groupTrendRecords(records, period) {
  if (!records.length) return { labels: [], values: [] };
  let groupSize = 1;
  if (period === "7d") groupSize = 24;
  if (period === "30d") groupSize = 24;
  if (period === "1y") groupSize = 24 * 30;

  const groups = [];
  for (let index = 0; index < records.length; index += groupSize) {
    const chunk = records.slice(index, index + groupSize);
    const timestamp = new Date(chunk[0].timestamp);
    groups.push({
      timestamp,
      total: chunk.reduce((sum, record) => sum + record.total, 0),
    });
  }

  if (period === "1y") {
    const monthly = new Map();
    for (const record of records) {
      const date = new Date(record.timestamp);
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const existing = monthly.get(key) || { timestamp: date, total: 0 };
      existing.total += record.total;
      monthly.set(key, existing);
    }
    const monthGroups = [...monthly.values()];
    return {
      labels: monthGroups.map((group) => group.timestamp.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })),
      values: monthGroups.map((group) => group.total),
    };
  }

  return {
    labels: groups.map((group) => {
      if (period === "live" || period === "24h") {
        return group.timestamp.toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });
      }
      return group.timestamp.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    }),
    values: groups.map((group) => group.total),
  };
}

function alignPreviousSeries(values, targetLength) {
  if (!values.length) return Array(targetLength).fill(0);
  if (values.length === targetLength) return values;
  return Array.from({ length: targetLength }, (_, index) => {
    const sourceIndex = Math.min(values.length - 1, Math.floor((index / targetLength) * values.length));
    return values[sourceIndex];
  });
}

function createTrendGradient(canvasId) {
  const canvas = document.getElementById(canvasId);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, "rgba(45, 212, 191, .22)");
  gradient.addColorStop(0.72, "rgba(45, 212, 191, .025)");
  gradient.addColorStop(1, "rgba(45, 212, 191, 0)");
  return gradient;
}

function baseCartesianOptions(tooltipLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    animation: { duration: 450 },
    plugins: {
      legend: { display: false },
      tooltip: chartTooltipOptions(tooltipLabel),
    },
    scales: {
      x: {
        border: { display: false },
        grid: { color: "rgba(145, 174, 198, .055)", drawTicks: false },
        ticks: {
          color: "#71879a",
          font: { size: 9, family: "Inter, system-ui, sans-serif" },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 12,
          padding: 8,
        },
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: "rgba(145, 174, 198, .07)", drawTicks: false },
        ticks: {
          color: "#71879a",
          font: { size: 9, family: "Inter, system-ui, sans-serif" },
          callback: (value) => compactFormatter.format(value),
          padding: 8,
          maxTicksLimit: 5,
        },
      },
    },
  };
}

function chartTooltipOptions(labelCallback) {
  return {
    backgroundColor: "rgba(7, 20, 33, .96)",
    borderColor: "rgba(145, 174, 198, .2)",
    borderWidth: 1,
    titleColor: "#edf5fb",
    bodyColor: "#a9bac8",
    padding: 10,
    cornerRadius: 8,
    displayColors: false,
    callbacks: { label: labelCallback },
  };
}

function trendTitleForPeriod(period) {
  return {
    live: "Recent hourly arrivals",
    "24h": "Hourly arrival trend",
    "7d": "Daily arrival trend",
    "30d": "Daily arrival trend",
    "1y": "Monthly arrival trend",
  }[period];
}

function buildDecorativeElements() {
  document.getElementById("peak-bars").innerHTML = Array.from({ length: 12 }, () => "<span></span>").join("");
  document.getElementById("hub-dots").innerHTML = Array.from({ length: 14 }, () => "<span></span>").join("");
}

function observeSections() {
  if (!("IntersectionObserver" in window)) return;
  const links = [...document.querySelectorAll(".nav-link")];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach((link) => {
        link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`);
      });
    },
    { rootMargin: "-25% 0px -60% 0px", threshold: [0.05, 0.2] },
  );
  sections.forEach((section) => observer.observe(section));
}

function downsample(values, target) {
  if (values.length <= target) return values;
  const result = [];
  for (let index = 0; index < target; index += 1) {
    const start = Math.floor((index / target) * values.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / target) * values.length));
    const chunk = values.slice(start, end);
    result.push(chunk.reduce((sum, value) => sum + value, 0) / chunk.length);
  }
  return result;
}

function seededValue(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash += hash << 13;
  hash ^= hash >>> 7;
  hash += hash << 3;
  hash ^= hash >>> 17;
  hash += hash << 5;
  return (hash >>> 0) / 4294967295;
}

function floorHour(date) {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function formatNumber(value) {
  return numberFormatter.format(Math.round(value || 0));
}

function formatHour(hour) {
  const normalized = positiveModulo(hour, 24);
  const suffix = normalized >= 12 ? "PM" : "AM";
  const display = normalized % 12 || 12;
  return `${display} ${suffix}`;
}

function formatDateTime(date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeTime(date) {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 3300);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
